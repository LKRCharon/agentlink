/**
 * Client for `codex app-server` — the JSON-RPC server that owns Codex threads.
 *
 * This is a different class of integration from transcript watching. Watching
 * infers what happened by tailing files; app-server *is* the session owner, so
 * a thread started in the Codex app or VS Code can be resumed here, spoken to,
 * steered mid-turn and interrupted. Verified against 0.146.0-alpha.3.1: a
 * vscode-sourced thread resumed from an outside connection reports
 * `canAcceptDirectInput: true`.
 *
 * Codex's own `remote-control` needs a server-side eligibility flag that most
 * accounts do not have yet. `app-server --listen ws://` needs nothing, which is
 * why Argus drives it directly.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the Codex desktop app keeps its bundled binary. */
const APP_BUNDLED = "/Applications/ChatGPT.app/Contents/Resources/codex";

export interface CodexThread {
  id: string;
  /** First user message, as Codex itself previews it. */
  preview: string;
  /** Model-generated title, nicer than the preview when present. */
  name?: string | null;
  cwd?: string | null;
  /** "notLoaded" until resumed; then idle / running / … */
  status: string;
  /**
   * cli | vscode | exec | appServer | subAgent | …
   *
   * The Codex desktop app reports `vscode`, not `appServer`: it is a VS Code
   * shell (app-server's own userAgent carries `vscode/1.106.3`, and the app
   * ships a `codex_vscode_copilot` originator for the real extension). This is
   * accurate, not stale data — do not "clean it up" by filtering vscode out.
   *
   * Sub-agent threads report an *object* here, not a string, which is why the
   * three fields below are extracted rather than left to callers.
   */
  source?: string | null;
  /** Set when this thread was spawned by another agent. */
  parentThreadId?: string | null;
  /** The codename the parent gave it ("Pauli", "Hilbert"). */
  agentNickname?: string | null;
  /** Nesting level; 1 means spawned directly by a top-level thread. */
  depth?: number | null;
  updatedAt: number;
  /** False for threads that cannot take input (e.g. sub-agent threads). */
  canAcceptDirectInput: boolean;
}

type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Pull the spawn details out of a thread's `source`.
 *
 * A top-level thread's source is a plain string ("vscode"); a spawned one is
 * `{ subAgent: { thread_spawn: { parent_thread_id, depth, agent_nickname } } }`.
 * Treating both as strings yielded "[object Object]" and lost the parent link,
 * which is the only thing tying an agent to the work that started it.
 */
function describeSpawn(source: unknown):
  { parentThreadId: string; depth: number; nickname: string | null } | null {
  if (!source || typeof source !== "object") return null;
  const sub = (source as any).subAgent ?? (source as any).subagent;
  const spawn = sub?.thread_spawn ?? sub?.threadSpawn;
  if (!spawn?.parent_thread_id && !spawn?.parentThreadId) return null;
  return {
    parentThreadId: String(spawn.parent_thread_id ?? spawn.parentThreadId),
    depth: Number(spawn.depth ?? 1),
    nickname: spawn.agent_nickname ?? spawn.agentNickname ?? null,
  };
}

/**
 * Turn history -> the phone's event vocabulary (text / user-text / thinking /
 * tool-call / tool-result / turn-done). Anything unrecognised is skipped rather
 * than guessed at, so a new item type shows up as missing content instead of
 * garbage.
 */
function flattenTurns(turns: any[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const turn of turns) {
    for (const item of turn?.items ?? []) {
      switch (item?.type) {
        case "userMessage": {
          const text = (item.content ?? [])
            .filter((c: any) => c?.type === "text" && typeof c.text === "string")
            .map((c: any) => c.text)
            .join("");
          if (text.trim()) out.push({ type: "user-text", text: text.trim() });
          break;
        }
        case "agentMessage":
          if (typeof item.text === "string" && item.text.trim()) {
            out.push({ type: "text", text: item.text });
          }
          break;
        case "reasoning": {
          // `summary` holds the headings Codex shows; `content` is the long form.
          const summary = Array.isArray(item.summary) ? item.summary.join("\n") : "";
          if (summary.trim()) out.push({ type: "thinking", text: summary });
          break;
        }
        case "commandExecution":
          out.push({
            type: "tool-call",
            name: "shell",
            summary: String(item.command ?? item.parsedCmd ?? "").slice(0, 300),
          });
          break;
        case "fileChange":
          out.push({
            type: "tool-call",
            name: "edit",
            summary: (item.changes ?? []).map((c: any) => c?.path).filter(Boolean).join(", ").slice(0, 300),
          });
          break;
        case "mcpToolCall":
          out.push({
            type: "tool-call",
            name: String(item.server ?? "mcp"),
            summary: String(item.tool ?? "").slice(0, 200),
          });
          break;
        default:
          break;
      }
    }
    // Only closed turns get a marker; an in-flight turn should stay "running".
    const status = typeof turn?.status === "string" ? turn.status : turn?.status?.type;
    if (status && status !== "inProgress" && status !== "running") {
      out.push({ type: "turn-done", reason: String(status) });
    }
  }
  return out;
}

export class CodexAppServer {
  private proc: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private ready: Promise<void> | null = null;

  /** Notifications from the server (thread/*, item/*, turn/*, …). */
  onNotification: ((method: string, params: any) => void) | null = null;
  /** Server-initiated requests — approvals arrive here and must be answered. */
  onServerRequest: ((id: number | string, method: string, params: any) => void) | null = null;

  constructor(private port = 9099) {}

  /** Codex binary to drive: prefer the desktop app's, fall back to a CLI on PATH. */
  static binaryPath(): string | null {
    if (existsSync(APP_BUNDLED)) return APP_BUNDLED;
    const standalone = join(homedir(), ".codex/packages/standalone/current/codex");
    if (existsSync(standalone)) return standalone;
    return null;
  }

  /** Spawn app-server (if needed) and complete the JSON-RPC handshake. */
  async start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const bin = CodexAppServer.binaryPath();
      if (!bin) throw new Error("未找到 codex 可执行文件（需安装 Codex 桌面版）");

      // Reuse an already-listening server rather than fighting it for the port:
      // the desktop app may have one up, and two servers on one port is a
      // startup failure, not a fallback.
      if (!(await this.probe())) {
        this.proc = spawn(bin, ["app-server", "--listen", `ws://127.0.0.1:${this.port}`], {
          stdio: "ignore",
          detached: true,
        });
        this.proc.unref();
        for (let i = 0; i < 40 && !(await this.probe()); i++) {
          await new Promise((r) => setTimeout(r, 250));
        }
        if (!(await this.probe())) throw new Error("app-server 启动超时");
      }

      await this.connect();
      await this.call("initialize", {
        clientInfo: { name: "argus", title: "Argus", version: "0.1.0" },
      });
    })();
    return this.ready;
  }

  /** `/healthz` answers before the socket accepts JSON-RPC, so poll it. */
  private async probe(): Promise<boolean> {
    try {
      const r = await fetch(`http://127.0.0.1:${this.port}/healthz`, {
        signal: AbortSignal.timeout(1000),
      });
      return r.ok;
    } catch {
      return false;
    }
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("app-server WebSocket 连接失败"));
      ws.onclose = () => {
        this.ws = null;
        this.ready = null;
        // Fail everything in flight: a reconnect gets fresh request ids, so a
        // pending entry here would never be answered.
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error("app-server 连接已断开"));
        }
        this.pending.clear();
      };
      ws.onmessage = (ev) => this.dispatch(String(ev.data));
    });
  }

  private dispatch(raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }

    if (typeof msg.id !== "undefined" && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? "app-server 错误"));
      else p.resolve(msg.result);
      return;
    }
    // A message with both id and method is a server->client request (approvals).
    if (typeof msg.id !== "undefined" && msg.method) {
      this.onServerRequest?.(msg.id, msg.method, msg.params);
      return;
    }
    if (msg.method) this.onNotification?.(msg.method, msg.params);
  }

  call<T = any>(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("app-server 未连接"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Answer a server-initiated request (this is how approvals get resolved). */
  respond(id: number | string, result: unknown): void {
    this.ws?.send(JSON.stringify({ id, result }));
  }

  // ---- thread operations ----------------------------------------------------

  /**
   * Every thread Codex knows about. `sourceKinds` matters: omitting it returns
   * only interactive sources, which silently hides app and exec threads.
   */
  async listThreads(limit = 40): Promise<CodexThread[]> {
    const res = await this.call<any>("thread/list", {
      // Omitting sourceKinds returns only "interactive sources" and answers
      // with zero rows on a machine full of sessions. `vscode` is what the
      // desktop app's own threads are tagged with, so it has to be in here.
      // The subAgent kinds matter too: without them, agents spawned by another
      // agent are filtered out and their work is invisible.
      sourceKinds: [
        "cli", "vscode", "exec", "appServer",
        "subAgent", "subAgentReview", "subAgentCompact",
        "subAgentThreadSpawn", "subAgentOther",
      ],
      limit,
    });
    const rows: any[] = res?.data ?? [];
    return rows.map((t) => {
      const spawn = describeSpawn(t.source);
      return {
        id: String(t.id),
        preview: String(t.preview ?? ""),
        name: t.name ?? null,
        cwd: t.cwd ?? null,
        status: typeof t.status === "object" ? String(t.status?.type ?? "unknown") : String(t.status ?? "unknown"),
        source: spawn ? "subAgent" : (typeof t.source === "string" ? t.source : null),
        parentThreadId: spawn?.parentThreadId ?? t.parentThreadId ?? null,
        agentNickname: spawn?.nickname ?? t.agentNickname ?? null,
        depth: spawn?.depth ?? null,
        updatedAt: Number(t.updatedAt ?? 0) * 1000,
        // Only meaningful once resumed; unresumed threads report null.
        canAcceptDirectInput: t.canAcceptDirectInput === true,
      };
    });
  }

  /**
   * Load a thread into the server so it can take input, and flatten its history
   * into the same event shape the live stream uses.
   *
   * Flattening happens here rather than on the phone: the item taxonomy
   * (userMessage / reasoning / agentMessage / commandExecution / fileChange …)
   * is app-server's, and teaching a second client about it would mean two places
   * to update when it changes.
   */
  async resume(threadId: string): Promise<{
    canAcceptDirectInput: boolean;
    turns: any[];
    events: Record<string, unknown>[];
    cwd?: string;
  }> {
    const res = await this.call<any>("thread/resume", { threadId });
    const turns: any[] = res?.initialTurnsPage?.data ?? res?.thread?.turns ?? [];
    return {
      canAcceptDirectInput: res?.thread?.canAcceptDirectInput === true,
      turns,
      events: flattenTurns(turns),
      cwd: res?.cwd,
    };
  }

  /** Send a message, starting a new turn. */
  async startTurn(threadId: string, text: string): Promise<string | null> {
    const res = await this.call<any>("turn/start", {
      threadId,
      input: [{ type: "text", text }],
    });
    return res?.turnId ?? res?.turn?.id ?? null;
  }

  /**
   * Redirect a turn that is already running. Needs the active turn id as a
   * precondition, so a stale steer cannot land on the wrong turn.
   */
  async steerTurn(threadId: string, turnId: string, text: string): Promise<void> {
    await this.call("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text }],
    });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.call("turn/interrupt", { threadId, turnId });
  }

  /** Start a brand-new thread in `cwd`. */
  async startThread(cwd?: string): Promise<string | null> {
    const res = await this.call<any>("thread/start", cwd ? { cwd } : {});
    return res?.thread?.id ?? res?.threadId ?? null;
  }

  stop(): void {
    this.ws?.close();
    this.ws = null;
    this.ready = null;
    // Leave a server we did not spawn alone — the desktop app may be using it.
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill(); } catch {}
    }
    this.proc = null;
  }
}
