/**
 * Client for `qodercli --acp` — Qoder's Agent Client Protocol endpoint.
 *
 * Why this exists alongside the transcript watcher: a phone-started Qoder
 * session used to run as `qodercli -p`, which reports nothing until its
 * transcript lands on disk. ACP streams what the agent is doing as it happens
 * (thinking, tool calls with titles and diffs, completion) and — the part `-p`
 * could never do — asks for permission through `session/request_permission`,
 * which the phone can answer.
 *
 * `--acp` is undocumented (absent from `--help`) but real. Verified against
 * qodercli 1.0.27: a full new-session/prompt/approve/complete round trip.
 *
 * Scope note: ACP resumes only sessions it created itself. The live IDE session
 * stays out of reach, which is why keystroke injection still exists for that.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Newest installed qodercli binary, or null when Qoder isn't present. */
export function qoderCliPath(): string | null {
  const base = join(homedir(), ".qoder", "bin", "qodercli");
  if (!existsSync(base)) return null;
  try {
    for (const v of readdirSync(base).filter((f) => f.startsWith("qodercli-")).sort().reverse()) {
      const p = join(base, v);
      if (existsSync(p)) return p;
    }
  } catch {}
  return null;
}

/** One streamed step, already flattened for the phone's activity feed. */
export interface AcpEvent {
  sessionId: string;
  /** thinking | message | tool | tool-done | done */
  type: string;
  text?: string;
  /** Tool title as Qoder words it (e.g. "Write /path/to/file"). */
  title?: string;
  /** read | edit | execute | … */
  kind?: string;
  status?: string;
}

export interface AcpPermission {
  sessionId: string;
  requestId: string;
  title: string;
  options: { id: string; label: string }[];
  /** Resolves the parked JSON-RPC request. */
  respond: (optionId: string) => void;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class QoderAcp {
  private proc: ChildProcess | null = null;
  /** Accumulating streamed text per session, flushed as one message. */
  private textBuffer = new Map<string, string>();
  private thinkBuffer = new Map<string, string>();
  private flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private ready: Promise<void> | null = null;
  /** Parked permission requests, keyed by the id we handed the phone. */
  private permissions = new Map<string, number | string>();

  constructor(
    private onEvent: (e: AcpEvent) => void,
    private onPermission: (p: AcpPermission) => void,
    /** Called when the agent process is gone, so callers can drop this instance. */
    private onExit?: () => void,
  ) {}

  /** Spawn the agent and negotiate the protocol. */
  async start(cwd: string): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const cli = qoderCliPath();
      if (!cli) throw new Error("未找到 qodercli");
      const child = spawn(cli, ["--acp"], {
        cwd: existsSync(cwd) ? cwd : homedir(),
        stdio: ["pipe", "pipe", "ignore"],
      });
      this.proc = child;
      child.stdout?.on("data", (b: Buffer) => this.feed(b.toString("utf8")));
      child.on("exit", () => this.handleExit());
      try {
        await this.call("initialize", {
          protocolVersion: 1,
          // We do not offer filesystem access: the agent runs locally and reads
          // files itself. Claiming otherwise would make it route reads through us.
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        }, 20_000);
      } catch (e) {
        // A timeout here leaves the process alive with a rejected `ready`,
        // i.e. an instance that can never work and never exits. Kill it so the
        // caller can start over.
        this.stop();
        throw e;
      }
    })();
    return this.ready;
  }

  /** Create a session and return its id. */
  async newSession(cwd: string): Promise<string> {
    const res = await this.call<any>("session/new", {
      cwd: existsSync(cwd) ? cwd : homedir(),
      mcpServers: [],
    }, 60_000);
    const id = res?.sessionId;
    if (!id) throw new Error("session/new 未返回 sessionId");
    return String(id);
  }

  /**
   * Send a prompt and resolve when the turn ends. Progress arrives through
   * `onEvent` while this is in flight, so the caller should not await it before
   * acknowledging the phone.
   */
  async prompt(sessionId: string, text: string): Promise<string> {
    try {
      const res = await this.call<any>("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }],
      }, 30 * 60_000);
      // Flush before reporting the turn as done, or the final reply is stranded
      // in the buffer and the phone shows a completed turn with no answer.
      this.flushStreamed(sessionId);
      return String(res?.stopReason ?? "end_turn");
    } catch (e) {
      // On timeout the agent may still be working on a turn no one is watching
      // any more; tell it to stop rather than leaving it running blind.
      await this.cancel(sessionId).catch(() => {});
      throw e;
    }
  }

  async cancel(sessionId: string): Promise<void> {
    // Notification, not a request: cancellation has no reply.
    this.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  }

  /** Answer a parked permission request with the option the phone chose. */
  resolvePermission(requestId: string, optionId: string): boolean {
    const id = this.permissions.get(requestId);
    if (id === undefined) return false;
    this.permissions.delete(requestId);
    this.write({ jsonrpc: "2.0", id, result: { outcome: { outcome: "selected", optionId } } });
    return true;
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
    this.ready = null;
  }

  // ---- plumbing -------------------------------------------------------------

  private write(obj: unknown): void {
    this.proc?.stdin?.write(`${JSON.stringify(obj)}\n`);
  }

  private call<T = any>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** ACP frames are newline-delimited JSON; a chunk may split one. */
  private feed(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: any): void {
    // Reply to something we sent.
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? "ACP 错误"));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "session/update") {
      this.handleUpdate(msg.params?.sessionId, msg.params?.update);
      return;
    }
    if (msg.method === "session/request_permission" && msg.id !== undefined) {
      const requestId = `acp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.permissions.set(requestId, msg.id);
      const raw: any[] = msg.params?.options ?? [];
      this.onPermission({
        sessionId: String(msg.params?.sessionId ?? ""),
        requestId,
        title: String(msg.params?.toolCall?.title ?? "需要授权"),
        options: raw.map((o) => ({ id: String(o.optionId), label: String(o.name ?? o.optionId) })),
        respond: (optionId) => this.resolvePermission(requestId, optionId),
      });
      return;
    }
    // Any other server request still needs an answer or the agent stalls.
    if (msg.id !== undefined && msg.method) {
      this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unsupported" } });
    }
  }

  /** Flatten an ACP update into the shape the phone's feed already renders. */
  private handleUpdate(sessionId: string | undefined, u: any): void {
    if (!sessionId || !u) return;
    const emit = (e: Omit<AcpEvent, "sessionId">) => this.onEvent({ sessionId, ...e });
    switch (u.sessionUpdate) {
      case "agent_thought_chunk":
        this.appendStreamed(sessionId, "thinking", String(u.content?.text ?? ""));
        break;
      case "agent_message_chunk":
        this.appendStreamed(sessionId, "message", String(u.content?.text ?? ""));
        break;
      case "tool_call":
        // `title` is Qoder's own wording ("Write /path/to/file"), which is
        // exactly what the activity feed wants — no translation. The diff comes
        // along too: seeing *what* changed is the point of remote oversight.
        emit({
          type: "tool", title: String(u.title ?? ""), kind: u.kind, status: u.status,
          text: describeToolContent(u.content),
        });
        break;
      case "tool_call_update":
        emit({ type: "tool-done", status: u.status, text: firstText(u.content) });
        break;
      default:
        // plan / available_commands_update / … — nothing to show yet.
        break;
    }
  }

  /**
   * Collect a streamed fragment, emitting the whole run shortly after it stops
   * growing. Markdown only parses correctly as a complete document, so a reply
   * has to reach the phone in one piece.
   */
  private appendStreamed(sessionId: string, kind: "message" | "thinking", text: string): void {
    if (!text) return;
    const buffer = kind === "message" ? this.textBuffer : this.thinkBuffer;
    buffer.set(sessionId, (buffer.get(sessionId) ?? "") + text);
    const pending = this.flushTimers.get(sessionId);
    if (pending) clearTimeout(pending);
    // 600ms of silence: a model can pause mid-sentence while thinking, and a
    // shorter window split replies at exactly the wrong places (the first token
    // "**" arrived as its own message). The turn's end flushes anyway, so this
    // only bounds how long a *complete* paragraph waits.
    this.flushTimers.set(sessionId, setTimeout(() => this.flushStreamed(sessionId), 600));
  }

  /** Emit whatever has accumulated, thinking first so the order reads right. */
  private flushStreamed(sessionId: string): void {
    const pending = this.flushTimers.get(sessionId);
    if (pending) {
      clearTimeout(pending);
      this.flushTimers.delete(sessionId);
    }
    const thought = this.thinkBuffer.get(sessionId);
    if (thought) {
      this.thinkBuffer.delete(sessionId);
      this.onEvent({ sessionId, type: "thinking", text: thought });
    }
    const message = this.textBuffer.get(sessionId);
    if (message) {
      this.textBuffer.delete(sessionId);
      this.onEvent({ sessionId, type: "message", text: message });
    }
  }

  private handleExit(): void {
    for (const [, t] of this.flushTimers) clearTimeout(t);
    this.flushTimers.clear();
    this.textBuffer.clear();
    this.thinkBuffer.clear();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("ACP 进程已退出"));
    }
    this.pending.clear();
    this.permissions.clear();
    this.proc = null;
    this.ready = null;
    this.onExit?.();
  }
}

/**
 * Summarise a tool call's content for the feed: a diff becomes a short
 * path + new-text preview, plain content falls back to its text.
 */
function describeToolContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const c of content) {
    const item = c as any;
    if (item?.type === "diff" && typeof item.path === "string") {
      const body = typeof item.newText === "string" ? item.newText.slice(0, 300) : "";
      return body ? `${item.path}\n${body}` : item.path;
    }
  }
  return firstText(content);
}

/** Pull the first text payload out of an ACP content array. */
function firstText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const c of content) {
    const t = (c as any)?.content?.text ?? (c as any)?.text;
    if (typeof t === "string" && t) return t.slice(0, 500);
  }
  return undefined;
}
