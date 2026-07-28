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
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WsConn, joinChan } from "../client";
import { TranscriptWatcher, findQoderFiles, findCodexFiles, normalizeQoderLine, normalizeCodexLine } from "./transcript";
import { HookServer } from "./hook-server";
import { listPeers } from "../store";

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
        }>(msg.data?.enc);

        if (payload?.kind === "permission-response" && payload.requestId) {
          // 手机端审批结果 → 解除 hook 等待
          hookServer.resolvePermission(payload.requestId, payload.optionId ?? "deny");
        } else if (payload?.kind === "user-input" && payload.text && payload.sessionId) {
          // 用户输入：注入运行中的 IDE 会话暂不可行 → 入收件箱 + 回执，
          // 手机端据此显示排队状态而不是石沉大海。
          queueUserInput(payload.sessionId, payload.text);
          emit({ type: "user_input", session: payload.sessionId, text: payload.text.slice(0, 100) });
          console.log(`[watch] 手机端输入已入收件箱: ${payload.text.slice(0, 100)}`);
          await sendPayload({
            kind: "input-ack",
            sessionId: payload.sessionId,
            status: "queued",
            note: "已送达 Mac · 暂不支持注入 IDE 会话，已存入收件箱",
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
