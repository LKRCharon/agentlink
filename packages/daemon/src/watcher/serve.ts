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
import { QoderAcp } from "../qoder-acp";

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

  /** Sessions whose injection Argus has not reported on yet. */
  const pendingInjections = new Set<string>();

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
  }, undefined, (sessionId, ok, note) => {
    // Argus finished (or failed) an injection: correct the provisional ack so
    // the phone stops showing "typing…" and learns why nothing happened.
    if (!pendingInjections.delete(sessionId)) return;
    enqueueSend({
      kind: "input-ack",
      sessionId,
      status: ok ? "running" : "queued",
      note: note || (ok ? "已输入到 Qoder" : "输入失败"),
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

  // Every asynchronous producer (transcript, ACP, app-server notifications,
  // approvals) must post through this one chain. Sealing is async, so parallel
  // sends race and the phone receives streamed text out of order — the chain
  // used to cover only the transcript path.
  let sendChain: Promise<void> = Promise.resolve();
  const enqueueSend = (payload: unknown): void => {
    sendChain = sendChain
      .then(() => sendPayload(payload))
      .catch((err) => {
        console.log(`[watch] 推送失败: ${err instanceof Error ? err.message : err}`);
      });
  };

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

  /**
   * Phone-started Qoder sessions, one ACP agent process each. Capped: every
   * entry is a live qodercli, so an unbounded map would quietly accumulate
   * processes for the lifetime of the daemon.
   */
  const acpBySession = new Map<string, QoderAcp>();
  /**
   * Sessions that were ACP-owned at some point, kept after the agent dies.
   * Without this, a follow-up message for a dead session fell through to
   * keystroke injection — which pastes into whatever the IDE currently has open
   * and presses Return, i.e. runs the prompt in an unrelated conversation while
   * telling the phone it was delivered.
   */
  const acpRetired = new Set<string>();
  const ACP_MAX_SESSIONS = 4;
  /** Which ACP agent parked which permission request. */
  const acpPermissions = new Map<string, QoderAcp>();

  /**
   * Start a Qoder session over ACP rather than `qodercli -p`. The difference is
   * feedback: ACP streams thinking, tool calls and completion as they happen,
   * and asks for permission in a way the phone can answer. `-p` reports nothing
   * until its transcript lands.
   */
  const startAcpSession = async (
    prompt: string,
    cwd: string,
  ): Promise<{ ok: boolean; note: string; sessionId?: string }> => {
    // Retire the oldest session when at capacity: Map preserves insertion order,
    // so the first key is the least recently started.
    while (acpBySession.size >= ACP_MAX_SESSIONS) {
      const oldest = acpBySession.keys().next().value;
      if (!oldest) break;
      acpBySession.get(oldest)?.stop();
      acpBySession.delete(oldest);
      acpRetired.add(oldest);
      console.log(`[watch] ACP 会话已达上限，回收最早的会话 ${oldest.slice(0, 8)}`);
    }

    let ownSessionId: string | null = null;
    const acp = new QoderAcp(
      (e) => {
        // These type names are a contract with the phone's buildFeed: it only
        // renders text / user-text / thinking / tool-call / tool-result /
        // turn-done, and reads error text from `message`. Inventing synonyms
        // ("agent-text", "tool-use") silently dropped the agent's own replies.
        const event =
          e.type === "thinking" ? { type: "thinking", text: e.text ?? "" }
          : e.type === "message" ? { type: "text", text: e.text ?? "" }
          : e.type === "tool" ? { type: "tool-call", name: e.title ?? "", summary: e.kind ?? "" }
          : e.type === "tool-done" ? { type: "tool-result", name: e.status ?? "", summary: e.text ?? "" }
          : { type: e.type, text: e.text ?? "" };
        enqueueSend({ kind: "agent-event", sessionId: e.sessionId, agent: "qoder", event });
      },
      (perm) => {
        acpPermissions.set(perm.requestId, acp);
        enqueueSend({
          kind: "permission-request",
          sessionId: perm.sessionId,
          agent: "qoder",
          requestId: perm.requestId,
          toolName: perm.title,
          summary: perm.title,
          options: perm.options.map((o) => ({ id: o.id, label: o.label })),
        });
      },
      () => {
        // The agent died: drop it, or later messages would be routed to a
        // process that can only reject them.
        if (ownSessionId) {
          acpBySession.delete(ownSessionId);
          acpRetired.add(ownSessionId);
        }
      },
    );
    try {
      await acp.start(cwd);
      const sessionId = await acp.newSession(cwd);
      ownSessionId = sessionId;
      acpBySession.set(sessionId, acp);
      // Do not await the turn: it can run for minutes, and progress already
      // streams through the callbacks above.
      void acp.prompt(sessionId, prompt)
        .then((stop) => sendPayload({
          kind: "agent-event", sessionId, agent: "qoder",
          event: { type: "turn-done", reason: stop },
        }))
        .catch((e) => sendPayload({
          kind: "agent-event", sessionId, agent: "qoder",
          event: { type: "error", message: `${e instanceof Error ? e.message : e}` },
        }));
      return { ok: true, note: `已在 ${cwd} 新建会话`, sessionId };
    } catch (e) {
      acp.stop();
      return { ok: false, note: `新建失败: ${e instanceof Error ? e.message : e}` };
    }
  };

  const codexControl = async (): Promise<CodexAppServer> => {
    if (codexServer) {
      // Always re-run start(): it is a no-op while connected, and after a socket
      // close (app restart, sleep) it reconnects. Returning the cached instance
      // blindly left every codex feature failing until the daemon restarted.
      try {
        await codexServer.start();
        return codexServer;
      } catch (e) {
        codexServer.stop();
        codexServer = null;
        throw e;
      }
    }
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
      } else if (threadId && (method === "turn/completed" || method === "turn/aborted"
                              || method === "turn/failed")) {
        // Not just completed: a turn interrupted on the desktop ends as
        // `turn/aborted`, and leaving its id in the map made every later phone
        // message steer a turn that no longer exists.
        activeTurns.delete(threadId);
      }
      // Forward the control-plane stream under its own kind: these are richer
      // than transcript events (reasoning deltas, command output deltas) and
      // the phone renders them separately.
      enqueueSend({ kind: "codex-event", method, params });
    };
    srv.onServerRequest = (id, method, params) => {
      // Approvals arrive as server->client requests; park the app-server id so
      // the phone's answer can resolve the right one.
      const requestId = `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      pendingApprovals.set(requestId, id);
      enqueueSend({
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
          /** Which agent a new session should use ("qoder" | "codex"). */
          agent?: string;
        }>(msg.data?.enc);

        // Only log genuine phone->daemon commands. Relay buffering can echo a
        // daemon->phone kind (agent-event, session-list, …) back at us; those
        // match no command branch below and are just noise in the log.
        const PHONE_COMMANDS = new Set([
          "list-sessions", "new-session", "user-input", "permission-response",
          "codex-threads", "codex-resume", "codex-input", "codex-interrupt",
          "cloud-session", "remote-control",
        ]);
        if (payload?.kind && PHONE_COMMANDS.has(payload.kind)) {
          console.log(`[watch] 收到手机指令: ${payload.kind}`);
        }
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
              // Flattened history, not raw turns: the phone speaks the event
              // vocabulary, not app-server's item taxonomy.
              events: r.events,
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
            let steered = false;
            if (active) {
              // Mid-turn: steer instead of queueing a second turn.
              try {
                await srv.steerTurn(payload.sessionId, active, payload.text);
                steered = true;
              } catch {
                // The turn ended without us hearing about it; drop the stale id
                // and fall back to a fresh turn rather than failing outright.
                activeTurns.delete(payload.sessionId);
              }
            }
            if (!steered) {
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
            // Delete first: if interrupt throws, the id is stale either way and
            // keeping it would wedge every later message into a failing steer.
            activeTurns.delete(payload.sessionId);
            await srv.interruptTurn(payload.sessionId, active);
            await sendPayload({ kind: "input-ack", sessionId: payload.sessionId, status: "done", note: "已打断" });
          } catch (e) {
            await sendPayload({ kind: "codex-error", note: `${e instanceof Error ? e.message : e}` });
          }
        } else if (payload?.kind === "list-sessions") {
          // The mirrored stream only ever showed sessions that emitted an event
          // while the phone was connected; this answers with every session on
          // disk, idle ones included.
          const rows = listSessions(60);
          console.log(`[watch] 返回会话目录 ${rows.length} 条`);
          await sendPayload({ kind: "session-list", sessions: rows });
        } else if (payload?.kind === "new-session" && payload.text) {
          const wantCodex = payload.agent === "codex";
          const cwd = payload.cwd ?? homedir();
          let r: { ok: boolean; note: string; sessionId?: string };
          if (wantCodex) {
            // Codex owns its threads, so a new one is a protocol call and the
            // first turn streams back like any other.
            try {
              const srv = await codexControl();
              const threadId = await srv.startThread(cwd);
              if (!threadId) throw new Error("thread/start 未返回 threadId");
              const turnId = await srv.startTurn(threadId, payload.text);
              if (turnId) activeTurns.set(threadId, turnId);
              r = { ok: true, note: `已在 ${cwd} 新建 Codex 会话`, sessionId: threadId };
            } catch (e) {
              r = { ok: false, note: `新建失败: ${e instanceof Error ? e.message : e}` };
            }
          } else {
            // ACP by default (visible progress + answerable approvals);
            // AGENTLINK_ACP=0 falls back to the silent `qodercli -p` route.
            r = process.env.AGENTLINK_ACP === "0"
              ? startSession(payload.text, payload.cwd)
              : await startAcpSession(payload.text, cwd);
          }
          const newId = r.sessionId;
          if (newId) {
            // Announce the session before its events arrive: the phone keys
            // everything by sessionId, and events for an id it has never seen
            // have nowhere to go — the agent's reply was invisible even though
            // it had answered.
            enqueueSend({
              kind: "session-started",
              sessionId: newId,
              agent: wantCodex ? "codex" : "qoder",
              cwd,
              prompt: payload.text,
            });
          }
          await sendPayload({
            kind: "input-ack",
            // The real id when we have one: an empty sessionId made the phone
            // look up sessions[""] and silently drop the acknowledgement.
            sessionId: newId ?? payload.sessionId ?? "",
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
                   && acpPermissions.has(payload.requestId)) {
          const acp = acpPermissions.get(payload.requestId)!;
          acpPermissions.delete(payload.requestId);
          acp.resolvePermission(payload.requestId, String(payload.optionId ?? "cancel"));
        } else if (payload?.kind === "permission-response" && payload.requestId
                   && pendingApprovals.has(payload.requestId)) {
          // Codex approval: answer the parked app-server request directly.
          const serverReqId = pendingApprovals.get(payload.requestId)!;
          pendingApprovals.delete(payload.requestId);
          codexServer?.respond(serverReqId, {
            decision: payload.optionId === "allow" ? "approved" : "denied",
          });
        } else if (payload?.kind === "permission-response" && payload.requestId
                   && !hookServer.hasPending(String(payload.requestId))) {
          // Neither ACP, Codex, nor a live hook request owns this id — most
          // likely a stale answer from before a daemon restart. Dropping it beats
          // handing an unrelated id to the hook server.
          console.log(`[watch] 忽略过期的审批回应 ${payload.requestId}`);
        } else if (payload?.kind === "permission-response" && payload.requestId) {
          // 手机端审批结果 → 解除 hook 等待
          hookServer.resolvePermission(payload.requestId, payload.optionId ?? "deny");
        } else if (payload?.kind === "user-input" && payload.text && payload.sessionId
                   && acpBySession.has(payload.sessionId)) {
          // Follow-up in a phone-started ACP session: keep it there rather than
          // falling through to keystroke injection, which would land in whatever
          // the IDE happens to have open.
          const acp = acpBySession.get(payload.sessionId)!;
          const sid = payload.sessionId;
          void acp.prompt(sid, payload.text)
            .then((stop) => sendPayload({
              kind: "agent-event", sessionId: sid, agent: "qoder",
              event: { type: "turn-done", reason: stop },
            }))
            .catch((e) => sendPayload({
              kind: "agent-event", sessionId: sid, agent: "qoder",
              event: { type: "error", message: `${e instanceof Error ? e.message : e}` },
            }));
          await sendPayload({
            kind: "input-ack", sessionId: sid, status: "running", note: "已发送到该会话",
          });
        } else if (payload?.kind === "user-input" && payload.sessionId
                   && acpRetired.has(payload.sessionId)) {
          // Dead ACP session: say so instead of injecting into the IDE.
          await sendPayload({
            kind: "input-ack", sessionId: payload.sessionId, status: "queued",
            note: "该会话的 agent 进程已结束，请新建会话",
          });
        } else if (payload?.kind === "user-input" && payload.text && payload.sessionId) {
          // 用户输入：注入运行中的 IDE 会话暂不可行 → 入收件箱 + 回执，
          // 手机端据此显示排队状态而不是石沉大海。
          queueUserInput(payload.sessionId, payload.text);
          // Full text, not a preview: Argus types this verbatim into the IDE.
          const cwd = watcher.cwdBySession.get(payload.sessionId)
            ?? codexWatcher.cwdBySession.get(payload.sessionId)
            ?? homedir();
          // Default route: hand the text to Argus, which types it into the
          // IDE's *current* session (the CLI cannot resume IDE sessions).
          // AGENTLINK_EXEC=1 opts into the old behaviour instead: spawn a
          // separate headless qodercli run, which answers in its own session.
          // The two routes are mutually exclusive: emitting the line for Argus
          // *and* spawning a headless run executed the same prompt twice.
          const spawnHeadless = process.env.AGENTLINK_EXEC === "1";
          if (spawnHeadless) {
            const result = execUserInput(payload.text, cwd);
            console.log(`[watch] 手机端输入 已起独立会话: ${payload.text.slice(0, 100)}`);
            await sendPayload({
              kind: "input-ack", sessionId: payload.sessionId,
              status: result.ok ? "running" : "queued", note: result.note,
            });
          } else {
            // Provisional ack only. The real outcome arrives from Argus through
            // /inject-result and replaces this one.
            pendingInjections.add(payload.sessionId);
            emit({ type: "user_input", session: payload.sessionId, text: payload.text });
            console.log(`[watch] 手机端输入 已转交 Argus 注入: ${payload.text.slice(0, 100)}`);
            await sendPayload({
              kind: "input-ack", sessionId: payload.sessionId,
              status: "running", note: "正在输入到 Mac 上的 Qoder…",
            });
          }
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
    // Kill the child agents too: ACP sessions are piped children, so they would
    // otherwise be orphaned holding a model connection each.
    for (const acp of acpBySession.values()) acp.stop();
    acpBySession.clear();
    codexServer?.stop();
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
