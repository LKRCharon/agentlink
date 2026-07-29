/**
 * Watch 桥接层：transcript watcher + hook server + relay 通道。
 * - transcript 新事件 → 加密 → 推到手机
 * - hook PermissionRequest → 加密 → 推到手机 → 等手机回复 → 回复 hook
 * - 手机 permission-response / user-input → 路由到 hook / 转发
 *
 * 结构化 stdout：以 {"type": 开头的行供 eclam/Argus 解析，其余为人类可读日志。
 */

import type { SecureChannel } from "@agentlink/wire";
import { b64decode } from "@agentlink/wire";
import type { NormalizedEvent } from "../agent/types";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WsConn, joinChan } from "../client";
import { TranscriptWatcher, findQoderFiles, findCodexFiles, normalizeQoderLine, normalizeCodexLine } from "./transcript";
import { HookServer } from "./hook-server";
import { listPeers } from "../store";
import { createCloudSession, listSessions, startRemoteControl, startSession } from "../sessions";
import { CodexAppServer } from "../codex-appserver";

export async function serveWatch(
  conn: WsConn,
  chan: SecureChannel,
  opts: { hookPort?: number } = {},
): Promise<{ hookServer: HookServer; watcher: TranscriptWatcher; codexWatcher: TranscriptWatcher; stop: () => void }> {
  const sendPayload = async (payload: unknown): Promise<void> => {
    conn.send({ op: "chan-data", data: { enc: await chan.seal(payload) } });
  };

  // 结构化 stdout：供 eclam/Argus 菜单栏 App 解析
  const emit = (obj: Record<string, unknown>): void => {
    process.stdout.write(JSON.stringify(obj) + "\n");
  };

  // 手机端消息收件箱：注入运行中的 IDE 会话暂不可行，先落盘排队，
  // 让消息在 Mac 上有迹可查（一行一条 JSON）。
  const inboxPath = (): string => {
    const dir = process.env.AGENTLINK_HOME ?? join(homedir(), ".agentlink");
    mkdirSync(dir, { recursive: true });
    return join(dir, "inbox.jsonl");
  };
  const queueUserInput = (sessionId: string, text: string): void => {
    appendFileSync(inboxPath(), JSON.stringify({ at: Date.now(), sessionId, text }) + "\n");
  };

  /** Newest installed qodercli binary, or null when Qoder isn't present. */
  const qoderCli = (): string | null => {
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
  };

  /** Run a phone-sent prompt as a headless qodercli session in `cwd`. The run
   *  writes its own transcript, so the watcher streams progress back to the
   *  phone with no extra plumbing. Permission prompts are skipped by design
   *  (owner's explicit choice); set AGENTLINK_EXEC=0 to disable execution and
   *  fall back to inbox-only queuing. */
  const execUserInput = (text: string, cwd: string): { ok: boolean; note: string } => {
    const cli = qoderCli();
    if (!cli) return { ok: false, note: "未找到 qodercli，已存入收件箱" };
    try {
      const child = spawn(cli, ["-p", text, "--dangerously-skip-permissions"], {
        cwd,
        stdio: "ignore",
        detached: true,
      });
      child.unref();
      return { ok: true, note: `已在 Mac 上执行（${cwd}）` };
    } catch (e) {
      return { ok: false, note: `启动失败: ${e instanceof Error ? e.message : e}` };
    }
  };

  const hookServer = new HookServer(async (req) => {
    await sendPayload({
      kind: "permission-request",
      sessionId: req.sessionId,
      agent: "qoder",
      requestId: req.requestId,
      toolName: req.toolName,
      summary: req.summary,
      options: req.options,
    });
  });

  const secret = HookServer.getOrCreateSecret();
  hookServer.start(secret);
  emit({ type: "hook_server", port: opts.hookPort ?? 9876, secret });

  // 打印 Qoder hook 配置提示
  console.log("\n--- Qoder hook 配置（粘贴到 ~/.qoder/settings.json 的 hooks 字段）---");
  console.log(JSON.stringify(
    {
      PermissionRequest: [{
        hooks: [{
          type: "http",
          url: `http://127.0.0.1:${opts.hookPort ?? 9876}/hook`,
          headers: { "X-Agentlink-Secret": secret },
        }],
      }],
    },
    null,
    2,
  ));
  console.log("---\n");

  let sessionCount = 0;
  const knownSessions = new Set<string>();

  // parseLines fires events without awaiting; chaining keeps seal/send order
  // deterministic (async seals otherwise race and arrive out of order) and
  // catches send failures so they don't surface as unhandled rejections.
  let sendChain: Promise<void> = Promise.resolve();

  const onWatchEvent = (sessionId: string, agent: string, event: NormalizedEvent): void => {
    sendChain = sendChain
      .then(async () => {
        if (!knownSessions.has(sessionId)) {
          knownSessions.add(sessionId);
          sessionCount = knownSessions.size;
          emit({ type: "status", connection: "channel-ready", sessions: sessionCount });
        }
        await sendPayload({ kind: "agent-event", sessionId, agent, event });
        emit({ type: "event", session: sessionId, agent, event: event.type });
        if (event.type === "turn-done") {
          knownSessions.delete(sessionId);
          sessionCount = knownSessions.size;
          emit({ type: "status", connection: "channel-ready", sessions: sessionCount });
        }
      })
      .catch((err) => {
        console.log(`[watch] 事件推送失败: ${err instanceof Error ? err.message : err}`);
      });
  };

  const watcher = new TranscriptWatcher(onWatchEvent, join(homedir(), ".qoder", "projects"), findQoderFiles, normalizeQoderLine, "qoder");
  watcher.start();

  /** Codex control plane, started on first use (it spawns a process). */
  let codexServer: CodexAppServer | null = null as CodexAppServer | null;
  /** Turn currently running per thread, so steer/interrupt have a target. */
  const activeTurns = new Map<string, string>();
  /** Approvals awaiting a phone answer: requestId -> app-server request id. */
  const pendingApprovals = new Map<string, number | string>();

  const codexControl = async (): Promise<CodexAppServer> => {
    if (codexServer) return codexServer;
    const srv = new CodexAppServer();
    srv.onNotification = (method, params) => {
      const threadId = params?.threadId;
      // The turn id lives in `turn.id`, not `turnId` (test/fixtures/
      // fake-codex-appserver.ts). Reading `turnId` here left activeTurns empty
      // for turns started in the desktop app, so those could never be steered
      // or interrupted — only turns this daemon started itself worked.
      const turnId = params?.turnId ?? params?.turn?.id;
      if (method === "turn/started" && threadId && turnId) {
        activeTurns.set(threadId, String(turnId));
      } else if (method === "turn/completed" && threadId) {
        activeTurns.delete(threadId);
      }
      // Forward the control-plane stream under its own kind: these are richer
      // than transcript events (reasoning deltas, command output deltas) and
      // the phone renders them separately.
      void sendPayload({ kind: "codex-event", method, params });
    };
    srv.onServerRequest = (id, method, params) => {
      // Approvals arrive as server->client requests; park the app-server id so
      // the phone's answer can resolve the right one.
      const requestId = `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      pendingApprovals.set(requestId, id);
      void sendPayload({
        kind: "permission-request",
        sessionId: String(params?.threadId ?? ""),
        agent: "codex",
        requestId,
        toolName: method,
        summary: JSON.stringify(params ?? {}).slice(0, 400),
        options: [
          { id: "allow", label: "允许" },
          { id: "deny", label: "拒绝" },
        ],
      });
    };
    await srv.start();
    codexServer = srv;
    return srv;
  };

  const codexWatcher = new TranscriptWatcher(onWatchEvent, join(homedir(), ".codex", "sessions"), findCodexFiles, normalizeCodexLine, "codex");
  codexWatcher.start();

  emit({ type: "status", connection: "channel-ready", sessions: 0 });
  console.log("[watch] 已启动：监听 Qoder + Codex transcript + hook server，Ctrl+C 退出");

  // 接收循环：处理手机端回复
  const receiveLoop = (async () => {
    for (;;) {
      let msg;
      try {
        msg = await conn.wait((m) => m.op === "chan-data", 24 * 3600_000);
      } catch {
        // 24h idle timeout is normal for long watch runs — keep listening.
        // (This used to escape as an unhandled rejection and kill the loop:
        // approvals silently stopped working while events kept flowing.)
        continue;
      }
      try {
        const payload = await chan.open<{
          kind?: string;
          requestId?: string;
          optionId?: string;
          text?: string;
          sessionId?: string;
          cwd?: string;
        }>(msg.data?.enc);

        if (payload?.kind === "codex-threads") {
          // Codex's own view of its threads — richer and more accurate than our
          // transcript scan (model-generated titles, live status, cwd).
          try {
            const srv = await codexControl();
            await sendPayload({ kind: "codex-thread-list", threads: await srv.listThreads(40) });
          } catch (e) {
            await sendPayload({ kind: "codex-error", note: `${e instanceof Error ? e.message : e}` });
          }
        } else if (payload?.kind === "codex-resume" && payload.sessionId) {
          try {
            const srv = await codexControl();
            const r = await srv.resume(payload.sessionId);
            await sendPayload({
              kind: "codex-resumed",
              sessionId: payload.sessionId,
              canAcceptDirectInput: r.canAcceptDirectInput,
              cwd: r.cwd ?? "",
              turns: r.turns,
            });
          } catch (e) {
            await sendPayload({ kind: "codex-error", note: `${e instanceof Error ? e.message : e}` });
          }
        } else if (payload?.kind === "codex-input" && payload.sessionId && payload.text) {
          // Real two-way control: this lands in the same thread the desktop app
          // or VS Code has open, not a separate headless run.
          try {
            const srv = await codexControl();
            await srv.resume(payload.sessionId);
            const active = activeTurns.get(payload.sessionId);
            if (active) {
              // Mid-turn: steer instead of queueing a second turn.
              await srv.steerTurn(payload.sessionId, active, payload.text);
            } else {
              const turnId = await srv.startTurn(payload.sessionId, payload.text);
              if (turnId) activeTurns.set(payload.sessionId, turnId);
            }
            await sendPayload({
              kind: "input-ack",
              sessionId: payload.sessionId,
              status: "running",
              note: active ? "已插话到进行中的回合" : "已发送到 Codex 会话",
            });
          } catch (e) {
            await sendPayload({
              kind: "input-ack",
              sessionId: payload.sessionId,
              status: "queued",
              note: `发送失败: ${e instanceof Error ? e.message : e}`,
            });
          }
        } else if (payload?.kind === "codex-interrupt" && payload.sessionId) {
          try {
            const srv = await codexControl();
            const active = activeTurns.get(payload.sessionId);
            if (!active) throw new Error("该会话当前没有进行中的回合");
            await srv.interruptTurn(payload.sessionId, active);
            activeTurns.delete(payload.sessionId);
            await sendPayload({ kind: "input-ack", sessionId: payload.sessionId, status: "done", note: "已打断" });
          } catch (e) {
            await sendPayload({ kind: "codex-error", note: `${e instanceof Error ? e.message : e}` });
          }
        } else if (payload?.kind === "list-sessions") {
          // The mirrored stream only ever showed sessions that emitted an event
          // while the phone was connected; this answers with every session on
          // disk, idle ones included.
          await sendPayload({ kind: "session-list", sessions: listSessions(60) });
        } else if (payload?.kind === "new-session" && payload.text) {
          const r = startSession(payload.text, payload.cwd);
          await sendPayload({
            kind: "input-ack",
            sessionId: payload.sessionId ?? "",
            status: r.ok ? "running" : "queued",
            note: r.note,
          });
        } else if (payload?.kind === "remote-control") {
          const r = startRemoteControl({ name: payload.text, directory: payload.cwd });
          await sendPayload({ kind: "input-ack", sessionId: "", status: r.ok ? "running" : "queued", note: r.note });
        } else if (payload?.kind === "cloud-session" && payload.text) {
          const r = await createCloudSession(payload.text, payload.cwd);
          await sendPayload({
            kind: "cloud-session-url",
            url: r.url ?? "",
            note: r.note,
          });
        } else if (payload?.kind === "permission-response" && payload.requestId
                   && pendingApprovals.has(payload.requestId)) {
          // Codex approval: answer the parked app-server request directly.
          const serverReqId = pendingApprovals.get(payload.requestId)!;
          pendingApprovals.delete(payload.requestId);
          codexServer?.respond(serverReqId, {
            decision: payload.optionId === "allow" ? "approved" : "denied",
          });
        } else if (payload?.kind === "permission-response" && payload.requestId) {
          // 手机端审批结果 → 解除 hook 等待
          hookServer.resolvePermission(payload.requestId, payload.optionId ?? "deny");
        } else if (payload?.kind === "user-input" && payload.text && payload.sessionId) {
          // 用户输入：注入运行中的 IDE 会话暂不可行 → 入收件箱 + 回执，
          // 手机端据此显示排队状态而不是石沉大海。
          queueUserInput(payload.sessionId, payload.text);
          // Full text, not a preview: Argus types this verbatim into the IDE.
          emit({ type: "user_input", session: payload.sessionId, text: payload.text });
          // Injecting into a running IDE session isn't possible, so run the
          // prompt as its own headless session in that session's cwd.
          const cwd = watcher.cwdBySession.get(payload.sessionId)
            ?? codexWatcher.cwdBySession.get(payload.sessionId)
            ?? homedir();
          // Default route: hand the text to Argus, which types it into the
          // IDE's *current* session (the CLI cannot resume IDE sessions).
          // AGENTLINK_EXEC=1 opts into the old behaviour instead: spawn a
          // separate headless qodercli run, which answers in its own session.
          const spawnHeadless = process.env.AGENTLINK_EXEC === "1";
          const result = spawnHeadless
            ? execUserInput(payload.text, cwd)
            : { ok: true, note: "已送到 Mac 上的 Qoder 会话" };
          console.log(`[watch] 手机端输入 ${spawnHeadless ? "已起独立会话" : "已转交 Argus 注入"}: ${payload.text.slice(0, 100)}`);
          await sendPayload({
            kind: "input-ack",
            sessionId: payload.sessionId,
            status: result.ok ? "running" : "queued",
            note: result.note,
          });
        }
      } catch {
        // 解密失败，忽略
      }
    }
  })();

  const stop = () => {
    watcher.stop();
    codexWatcher.stop();
    hookServer.stop();
  };

  return { hookServer, watcher, codexWatcher, stop };
}

/** watch 命令入口：连接已配对设备的通道 + 启动监听 */
export async function runWatch(opts: { hookPort?: number } = {}): Promise<void> {
  const peers = Object.values(listPeers());
  if (peers.length === 0) throw new Error("尚未配对任何设备，请先运行 pair");

  const peer = peers.sort((a, b) => b.pairedAt - a.pairedAt)[0];
  const conn = await WsConn.connect(process.env.AGENTLINK_RELAY ?? "ws://127.0.0.1:8787/ws");
  // Relay drop used to be invisible: no reconnect, stale channel-ready in the
  // menu bar, and every push turning into an unhandled rejection. Exit loudly
  // instead — the GUI treats daemon exit as disconnected and can restart it.
  conn.onClose = () => {
    process.stdout.write(JSON.stringify({ type: "status", connection: "disconnected" }) + "\n");
    console.log("[watch] relay 连接断开，退出");
    process.exit(1);
  };
  const longTermKey = b64decode(peer.longTermKey);
  const chan = await joinChan(conn, longTermKey);
  console.log(`已连接对端 ${peer.deviceName}，启动 watch 模式…`);
  process.stdout.write(JSON.stringify({ type: "status", connection: "connecting" }) + "\n");

  const { stop } = await serveWatch(conn, chan, opts);

  process.on("SIGINT", () => {
    stop();
    conn.close();
    process.exit(0);
  });

  // 保持进程运行
  await new Promise(() => {});
}
