/**
 * Qoder session control: list, create and share sessions from the phone.
 *
 * Three routes exist for driving a session remotely, and they solve different
 * problems:
 *
 *   A. keystroke injection (Argus side) — the only way into the session the
 *      user is *currently* looking at in the IDE, because the CLI and the IDE
 *      keep separate session namespaces (`--list-sessions` never shows IDE
 *      sessions).
 *   B. `qodercli remote-control` — Qoder's own bridge server. Sessions started
 *      through it can be attached from more than one place, so a *new* session
 *      is genuinely shared instead of mirrored.
 *   C. `qodercli --remote` — a cloud session that prints an access URL the
 *      phone can open directly.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** Newest installed qodercli binary, or null when Qoder isn't present. */
export function qoderCliPath(): string | null {
  const base = join(homedir(), ".qoder", "bin", "qodercli");
  if (!existsSync(base)) return null;
  try {
    const versions = readdirSync(base)
      .filter((f) => f.startsWith("qodercli-"))
      .sort()
      .reverse();
    for (const v of versions) {
      const p = join(base, v);
      if (existsSync(p)) return p;
    }
  } catch {}
  return null;
}

export interface SessionSummary {
  /** Transcript-derived id (what the mirrored event stream keys on). */
  id: string;
  /** First user prompt, trimmed — the phone shows this as the title. */
  title: string;
  agent: "qoder" | "codex";
  /** Absolute project directory, when the transcript recorded one. */
  cwd?: string;
  /** Last write to the transcript (ms). */
  updatedAt: number;
  /** `quest` = IDE task transcript, `chat` = CLI/standalone session. */
  kind: "quest" | "chat";
}

/** How much of a transcript to read when looking for its first prompt. */
const HEAD_BYTES = 256 * 1024;

/**
 * Cache of parsed titles, keyed by path + mtime. A transcript's first prompt
 * never changes, so a hit is exact; the mtime in the key retires the entry when
 * the file is rewritten.
 */
const titleCache = new Map<string, { title: string; cwd?: string }>();

/** Strip the injected scaffolding that rides along in the user role. */
function isSyntheticPrompt(text: string): boolean {
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

function oneLine(text: string, max = 80): string {
  return text.trim().replace(/\s+/g, " ").slice(0, max);
}

/**
 * Read just enough of a transcript to title it. Sessions can be tens of MB, so
 * this reads the head rather than the whole file — the first real user prompt
 * is always near the top.
 */
function firstPrompt(file: string, agent: "qoder" | "codex"): { title: string; cwd?: string } {
  let head = "";
  try {
    // Read only the head. `readFileSync` used to pull the whole file into memory
    // before slicing — 313 transcripts totalling ~460MB on this machine, read
    // synchronously on every list refresh, freezing the event loop for ~100ms
    // warm and ~340ms cold.
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.allocUnsafe(HEAD_BYTES);
      const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
      head = buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return { title: basename(file) };
  }
  let cwd: string | undefined;
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    cwd ??= typeof o?.cwd === "string" ? o.cwd : o?.payload?.cwd;
    if (agent === "qoder") {
      if (o?.type !== "user") continue;
      const content = o?.message?.content;
      if (typeof content === "string") {
        if (!isSyntheticPrompt(content)) return { title: oneLine(content), cwd };
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === "text" && typeof b.text === "string" && !isSyntheticPrompt(b.text)) {
            return { title: oneLine(b.text), cwd };
          }
        }
      }
    } else {
      if (o?.type === "event_msg" && o?.payload?.type === "user_message") {
        const t = String(o.payload.message ?? "");
        if (!isSyntheticPrompt(t)) return { title: oneLine(t), cwd };
      }
    }
  }
  return { title: basename(file).replace(/\.jsonl$/, ""), cwd };
}

/** `rollout-<timestamp>-<threadId>.jsonl` -> threadId (app-server's id). */
function codexThreadId(file: string): string {
  const base = basename(file).replace(/\.jsonl$/, "");
  const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return m ? m[1] : base;
}

function walkFiles(root: string, depth: number, out: string[]): void {
  if (depth < 0) return;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) walkFiles(p, depth - 1, out);
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
}

/**
 * Every session on this Mac, newest first — including long-idle ones, which is
 * the point: the phone previously only ever saw sessions that happened to emit
 * an event while it was connected.
 */
export function listSessions(limit = 60): SessionSummary[] {
  const out: SessionSummary[] = [];
  const cachedPrompt = (file: string, agent: "qoder" | "codex", mtimeMs: number) => {
    const key = `${file}:${mtimeMs}`;
    const hit = titleCache.get(key);
    if (hit) return hit;
    const parsed = firstPrompt(file, agent);
    // Bounded so a long-lived daemon does not accumulate entries for every
    // transcript that ever existed.
    if (titleCache.size > 400) titleCache.clear();
    titleCache.set(key, parsed);
    return parsed;
  };

  const qoderRoot = join(homedir(), ".qoder", "projects");
  const qoderFiles: string[] = [];
  walkFiles(qoderRoot, 3, qoderFiles);
  for (const f of qoderFiles) {
    let updatedAt = 0;
    try { updatedAt = statSync(f).mtimeMs; } catch { continue; }
    const { title, cwd } = cachedPrompt(f, "qoder", updatedAt);
    out.push({
      id: basename(f).replace(/\.jsonl$/, ""),
      title,
      agent: "qoder",
      cwd,
      updatedAt,
      // IDE task transcripts live under `<project>/transcript/`; anything else
      // under projects/ came from the CLI.
      kind: f.includes("/transcript/") ? "quest" : "chat",
    });
  }

  const codexRoot = join(homedir(), ".codex", "sessions");
  const codexFiles: string[] = [];
  walkFiles(codexRoot, 4, codexFiles);
  for (const f of codexFiles) {
    let updatedAt = 0;
    try { updatedAt = statSync(f).mtimeMs; } catch { continue; }
    const { title, cwd } = cachedPrompt(f, "codex", updatedAt);
    out.push({
      // Trailing uuid, not the whole basename: it is the app-server threadId,
      // and using anything else splits one session into two cards.
      id: codexThreadId(f),
      title,
      agent: "codex",
      cwd,
      updatedAt,
      kind: "chat",
    });
  }

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return out
    // Drop sub-agent transcripts: they carry no prompt of their own, so the
    // title falls back to a bare UUID — noise in a session picker.
    .filter((s) => !UUID.test(s.title))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

/** Start a fresh headless session with `prompt` in `cwd`. */
export function startSession(prompt: string, cwd?: string): { ok: boolean; note: string } {
  const cli = qoderCliPath();
  if (!cli) return { ok: false, note: "未找到 qodercli" };
  const dir = cwd && existsSync(cwd) ? cwd : homedir();
  try {
    const child = spawn(cli, ["-p", prompt, "--dangerously-skip-permissions"], {
      cwd: dir,
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    return { ok: true, note: `已在 ${dir} 新建会话` };
  } catch (e) {
    return { ok: false, note: `新建失败: ${e instanceof Error ? e.message : e}` };
  }
}

/**
 * Route B — Qoder's own remote-control bridge. Sessions scheduled by this
 * server can be attached from elsewhere (`--teleport`), which is what makes a
 * session genuinely shared rather than mirrored.
 */
export function startRemoteControl(opts: { name?: string; directory?: string } = {}):
  { ok: boolean; note: string } {
  const cli = qoderCliPath();
  if (!cli) return { ok: false, note: "未找到 qodercli" };
  const args = ["remote-control"];
  if (opts.name) args.push("--name", opts.name);
  args.push("--directory", opts.directory ?? homedir());
  try {
    const child = spawn(cli, args, { stdio: "ignore", detached: true });
    child.unref();
    return { ok: true, note: "remote-control 桥接已启动" };
  } catch (e) {
    return { ok: false, note: `启动失败: ${e instanceof Error ? e.message : e}` };
  }
}

/**
 * Route C — cloud session. `--remote` prints an access URL on stdout; the phone
 * can open it directly, no relay involved. Resolves once the URL appears (or
 * after a timeout, so a hung CLI does not hang the caller).
 */
export function createCloudSession(task: string, cwd?: string): Promise<{ ok: boolean; url?: string; note: string }> {
  const cli = qoderCliPath();
  if (!cli) return Promise.resolve({ ok: false, note: "未找到 qodercli" });
  const dir = cwd && existsSync(cwd) ? cwd : homedir();
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    const child = spawn(cli, ["--remote", task], { cwd: dir });
    const finish = (r: { ok: boolean; url?: string; note: string }) => {
      if (settled) return;
      settled = true;
      // Kill the child: a hung `--remote` would otherwise pile up one stray
      // qodercli per attempt, since resolving the promise does not reap it.
      try { child.kill(); } catch {}
      resolve(r);
    };
    const scan = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const m = buffer.match(/https?:\/\/\S+/);
      if (m) finish({ ok: true, url: m[0], note: "云会话已创建" });
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    child.on("error", (e) => finish({ ok: false, note: `启动失败: ${e.message}` }));
    child.on("exit", () => finish({ ok: false, note: "未能获取云会话地址" }));
    setTimeout(() => finish({ ok: false, note: "创建云会话超时" }), 60_000);
  });
}
