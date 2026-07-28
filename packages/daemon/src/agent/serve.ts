/**
 * 桥接层：AgentSession（归一化事件）⇄ SecureChannel（手机端）。
 * - agent 事件/权限请求 → 密封转发到通道
 * - 通道里的 permission-response / user-input → 回给 agent
 * - 权限请求 10 分钟无响应自动按拒绝处理
 */

import type { SecureChannel } from "@agentlink/wire";
import type { WsConn } from "../client";
import type { AgentAdapter, AgentSession } from "./types";

const PERMISSION_TIMEOUT_MS = 10 * 60_000;

export async function serveAgent(
  conn: WsConn,
  chan: SecureChannel,
  adapter: AgentAdapter,
  opts: { cwd: string; prompt?: string; model?: string },
): Promise<void> {
  const session = await adapter.start(opts);
  const sessionId = session.id;
  const sendPayload = async (payload: unknown): Promise<void> => {
    conn.send({ op: "chan-data", data: { enc: await chan.seal(payload) } });
  };

  await sendPayload({
    kind: "agent-event",
    sessionId,
    agent: adapter.name,
    event: { type: "text", text: `[agentlink] ${adapter.name} 会话已建立（${opts.cwd}）` },
  });

  const permissionWaiters = new Map<string, (optionId: string) => void>();

  const forward = (async (): Promise<void> => {
    for await (const ev of session.events) {
      if (ev.type === "permission-request") {
        await sendPayload({
          kind: "permission-request",
          sessionId,
          agent: adapter.name,
          requestId: ev.requestId,
          toolName: ev.toolName,
          summary: ev.summary,
          options: ev.options,
        });
        const optionId = await new Promise<string>((resolve) => {
          permissionWaiters.set(ev.requestId, resolve);
          setTimeout(() => {
            if (permissionWaiters.delete(ev.requestId)) resolve("__deny__");
          }, PERMISSION_TIMEOUT_MS);
        });
        await ev.respond(optionId);
      } else {
        await sendPayload({ kind: "agent-event", sessionId, agent: adapter.name, event: ev });
      }
    }
  })();

  const receive = (async (): Promise<void> => {
    for (;;) {
      const msg = await conn.wait((m) => m.op === "chan-data", 24 * 3600_000);
      try {
        const payload = await chan.open<{
          kind?: string;
          requestId?: string;
          optionId?: string;
          text?: string;
        }>(msg.data?.enc);
        if (payload?.kind === "permission-response" && payload.requestId) {
          permissionWaiters.get(payload.requestId)?.(payload.optionId ?? "__deny__");
          permissionWaiters.delete(payload.requestId);
        } else if (payload?.kind === "user-input" && typeof payload.text === "string") {
          await session.send(payload.text);
        }
      } catch {
        // 无法解密/识别的消息，忽略
      }
    }
  })();

  await Promise.race([forward, receive]);
  await session.stop();
}

export type { AgentSession };
