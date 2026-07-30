/**
 * 通用 transcript 监听器：轮询 JSONL 文件，解析新增行并归一化为 AgentEvent。
 * 支持 Qoder 和 Codex 两种会话文件格式。
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { statSync, readdirSync, openSync, readSync, closeSync } from "node:fs";
import type { NormalizedEvent } from "../agent/types";

export type LineNormalizer = (line: unknown) => NormalizedEvent[];

interface WatchedFile {
  path: string;
  size: number;
  sessionId: string;
}

export class TranscriptWatcher {
  /** sessionId -> cwd, harvested from transcript lines. Remote execution needs
   *  the originating working directory; both formats carry it (qoder: top-level
   *  `cwd`, codex: `turn_context.payload.cwd`). */
  readonly cwdBySession = new Map<string, string>();
  private files = new Map<string, WatchedFile>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly pollMs: number;

  constructor(
    private onEvent: (sessionId: string, agent: string, event: NormalizedEvent) => void,
    private rootDir: string,
    private findFiles: (root: string) => string[],
    private normalizer: LineNormalizer,
    private agentName: string,
    pollMs = 2000,
  ) {
    this.pollMs = pollMs;
  }

  start(): void {
    if (this.timer) return;
    this.scan(); // 首次扫描，初始化文件位置（跳到末尾，只推新事件）
    this.timer = setInterval(() => this.scan(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private scan(): void {
    let files: string[];
    try {
      files = this.findFiles(this.rootDir);
    } catch {
      return;
    }

    const seenPaths = new Set<string>();

    for (const filePath of files) {
        seenPaths.add(filePath);
        let stat;
        try {
          stat = statSync(filePath);
        } catch {
          continue;
        }

        const existing = this.files.get(filePath);
        if (!existing) {
          // 新文件：跳到末尾，只推后续新事件
          this.files.set(filePath, {
            path: filePath,
            size: stat.size,
            sessionId: this.extractSessionId(filePath),
          });
          continue;
        }

        if (stat.size > existing.size) {
          // 文件增长：只消费到最后一个换行符。stat 撞上写入中途时，尾部半行
          // （大 JSONL 行跨多次 write）一旦被消费，前后两半都 parse 失败而
          // 永久丢事件；残行留到下一轮拼整（多字节 UTF-8 边界同理）。
          const buf = this.readTail(filePath, existing.size, stat.size);
          const lastNl = buf.lastIndexOf(0x0a);
          if (lastNl < 0) continue;
          existing.size += lastNl + 1;
          this.parseLines(buf.subarray(0, lastNl + 1).toString("utf8"), existing.sessionId);
        } else if (stat.size < existing.size) {
          // 文件被截断/轮转：重置
          existing.size = stat.size;
        }
    }

    // 清理已删除的文件
    for (const path of this.files.keys()) {
      if (!seenPaths.has(path)) this.files.delete(path);
    }
  }

  private readTail(filePath: string, start: number, end: number): Buffer {
    try {
      const buf = Buffer.alloc(end - start);
      const fd = openSync(filePath, "r");
      readSync(fd, buf, 0, buf.length, start);
      closeSync(fd);
      return buf;
    } catch {
      return Buffer.alloc(0);
    }
  }

  private extractSessionId(filePath: string): string {
    const base = (filePath.split("/").pop() ?? filePath).replace(/\.jsonl$/, "");
    // Codex rollout files are named `rollout-<timestamp>-<threadId>`, and that
    // trailing uuid is exactly the app-server threadId (verified against
    // session_meta.payload.id). Using the whole basename gave codex sessions two
    // different ids: the phone showed one card per id, and the card with the
    // content could not accept input because thread/resume rejects it.
    const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    return m ? m[1] : base;
  }

  private parseLines(data: string, sessionId: string): void {
    for (const line of data.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        const cwd = obj?.cwd ?? obj?.payload?.cwd;
        if (typeof cwd === "string" && cwd) this.cwdBySession.set(sessionId, cwd);
        const events = this.normalizer(obj);
        for (const ev of events) {
          this.onEvent(sessionId, this.agentName, ev);
        }
      } catch {
        // 非 JSON 行或解析失败，跳过
      }
    }
  }
}

// ---------- 文件查找函数 ----------

export function findQoderFiles(root: string): string[] {
  const results: string[] = [];
  try {
    for (const proj of readdirSync(root, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      const tdir = join(root, proj.name, "transcript");
      try {
        for (const f of readdirSync(tdir)) {
          if (f.endsWith(".jsonl")) results.push(join(tdir, f));
        }
      } catch {}
    }
  } catch {}
  return results;
}

export function findCodexFiles(root: string): string[] {
  const results: string[] = [];
  try {
    for (const year of readdirSync(root, { withFileTypes: true })) {
      if (!year.isDirectory()) continue;
      const yearDir = join(root, year.name);
      for (const month of readdirSync(yearDir, { withFileTypes: true })) {
        if (!month.isDirectory()) continue;
        const monthDir = join(yearDir, month.name);
        for (const day of readdirSync(monthDir, { withFileTypes: true })) {
          if (!day.isDirectory()) continue;
          const dayDir = join(monthDir, day.name);
          try {
            for (const f of readdirSync(dayDir)) {
              if (f.endsWith(".jsonl")) results.push(join(dayDir, f));
            }
          } catch {}
        }
      }
    }
  } catch {}
  return results;
}

// ---------- 归一化函数 ----------

/** Qoder transcript JSONL 行 → NormalizedEvent[] */
export function normalizeQoderLine(line: unknown): NormalizedEvent[] {
  const obj = line as { type?: string; data?: any; message?: any };
  const events: NormalizedEvent[] = [];

  if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
    for (const block of obj.message.content) {
      if (block.type === "text" && block.text) {
        events.push({ type: "text", text: block.text });
      } else if (block.type === "thinking" && block.thinking) {
        events.push({ type: "thinking", text: String(block.thinking).slice(0, 300) });
      } else if (block.type === "redacted_thinking") {
        // Encrypted reasoning: the content is unreadable by design, but dropping
        // the block entirely made a turn look like it skipped straight to the
        // answer with no thinking at all.
        events.push({ type: "thinking", text: "（已加密的推理内容）" });
      } else if (block.type === "tool_use") {
        events.push({
          type: "tool-call",
          name: block.name ?? "tool",
          summary: toolSummary(block.name ?? "tool", block.input).slice(0, 200),
        });
      }
    }
  } else if (obj.type === "user" && typeof obj.message?.content === "string") {
    // A plain string in the user role is what the human actually typed.
    if (!isSyntheticUserText(obj.message.content)) {
      events.push({ type: "user-text", text: obj.message.content.slice(0, 2000) });
    }
  } else if (obj.type === "user" && obj.message?.content && Array.isArray(obj.message.content)) {
    // Tool outputs come back as user-role tool_result blocks; text blocks in
    // the same array are either the prompt or injected scaffolding.
    for (const block of obj.message.content) {
      if (block?.type === "text" && typeof block.text === "string") {
        if (!isSyntheticUserText(block.text)) {
          events.push({ type: "user-text", text: block.text.slice(0, 2000) });
        }
        continue;
      }
      if (block?.type !== "tool_result") continue;
      const c = block.content;
      const text = typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c.map((p: any) => (typeof p === "string" ? p : p?.text ?? "")).join(" ")
          : safeStringify(c);
      events.push({ type: "tool-result", name: "tool", summary: text.slice(0, 200) });
    }
  } else if (obj.type === "progress" && obj.data?.hookEvent === "Stop") {
    events.push({ type: "turn-done", reason: "stop" });
  }

  return events;
}

/** Codex rollout JSONL 行 → NormalizedEvent[] */
export function normalizeCodexLine(line: unknown): NormalizedEvent[] {
  const obj = line as { type?: string; payload?: any };
  const events: NormalizedEvent[] = [];

  if (obj.type === "response_item" && obj.payload?.type === "message") {
    const role = obj.payload.role;
    const content = obj.payload.content ?? [];
    for (const block of content) {
      if (role === "assistant" && (block.type === "output_text" || block.type === "text") && block.text) {
        events.push({ type: "text", text: block.text });
      }
    }
  } else if (obj.type === "response_item" && obj.payload?.type === "function_call") {
    let args: unknown = obj.payload.arguments;
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch {}
    }
    events.push({
      type: "tool-call",
      name: obj.payload.name ?? "tool",
      summary: toolSummary(obj.payload.name ?? "tool", args).slice(0, 200),
    });
  } else if (obj.type === "response_item" && obj.payload?.type === "function_call_output") {
    events.push({ type: "tool-result", name: "tool", summary: outputText(obj.payload.output).slice(0, 200) });
  } else if (obj.type === "event_msg" && obj.payload?.type === "user_message") {
    // Only this event carries the typed prompt; response_item/message(role=user)
    // duplicates it, so it stays ignored.
    const text = String(obj.payload.message ?? "");
    if (!isSyntheticUserText(text)) {
      events.push({ type: "user-text", text: text.slice(0, 2000) });
    }
  } else if (obj.type === "response_item" && obj.payload?.type === "reasoning") {
    const parts = (obj.payload.summary ?? [])
      .map((s: any) => s?.text ?? "")
      .filter(Boolean);
    if (parts.length) events.push({ type: "thinking", text: parts.join(" · ").slice(0, 300) });
  } else if (obj.type === "response_item" && obj.payload?.type === "custom_tool_call") {
    const name = obj.payload.name ?? "tool";
    const cmds = codexExecCommands(obj.payload.input);
    if (cmds.length) {
      // One row per command — a single blob of wrapper JS is unreadable.
      for (const cmd of cmds) {
        events.push({ type: "tool-call", name, summary: cmd.slice(0, 200) });
      }
    } else {
      events.push({ type: "tool-call", name, summary: String(obj.payload.input ?? "").slice(0, 200) });
    }
  } else if (obj.type === "response_item" && obj.payload?.type === "custom_tool_call_output") {
    events.push({ type: "tool-result", name: obj.payload.name ?? "tool", summary: outputText(obj.payload.output).slice(0, 200) });
  } else if (obj.type === "event_msg" && obj.payload?.type === "task_complete") {
    // Real codex rollouts emit task_complete / turn_aborted ("turn_ended"
    // does not exist in the format).
    events.push({ type: "turn-done", reason: "completed" });
  } else if (obj.type === "event_msg" && obj.payload?.type === "turn_aborted") {
    events.push({ type: "turn-done", reason: "aborted" });
  }

  return events;
}

/** The one field worth showing per tool, Codex-activity-list style: the
 *  command, the path, the query — never the whole argument object. Falls back
 *  to compact JSON for unknown tools. */
function toolSummary(name: string, input: unknown): string {
  if (typeof input === "string") return input;
  const o = (input ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return undefined;
  };
  const direct = pick("command", "cmd", "file_path", "path", "regex", "query", "url", "pattern");
  if (direct) return direct;
  const n = name.toLowerCase();
  if (n.includes("todo")) {
    const todos = o.todos;
    return Array.isArray(todos) ? `${todos.length} items` : "";
  }
  if (n === "agent" || n.includes("task")) return pick("description", "prompt") ?? "";
  return safeStringify(input);
}

/** codex `exec` input is JS calling tools.exec_command({ cmd: "…" }) — one call
 *  or several. Pull the commands out so each becomes its own activity row
 *  (matching how Codex itself lists "ran multiple commands"). */
function codexExecCommands(input: unknown): string[] {
  if (typeof input !== "string") return [];
  const out: string[] = [];
  // cmd: "..." with escaped quotes inside
  const re = /cmd:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    try {
      out.push(JSON.parse(`"${m[1]}"`));
    } catch {
      out.push(m[1]);
    }
  }
  return out;
}

/** Injected blocks that ride along in the user role but nobody typed:
 *  annotation preambles, system reminders, harness scaffolding. */
function isSyntheticUserText(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  return (
    t.startsWith("#") ||
    t.startsWith("<") ||
    t.startsWith("Command completed") ||
    t.startsWith("Command output") ||
    t.includes("system-reminder")
  );
}

/** codex tool outputs arrive as string OR [{type:"input_text",text}] parts. */
function outputText(out: unknown): string {
  if (typeof out === "string") return out;
  if (Array.isArray(out)) return out.map((p: any) => p?.text ?? "").join(" ");
  return safeStringify(out);
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}
