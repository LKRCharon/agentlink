/**
 * 归一化 agent 事件协议（M1.2）。
 * 各家 agent（Qoder ACP / Codex app-server / 未来 ACP 家族）在 daemon 侧
 * 统一映射为这里的载荷，经 SecureChannel 传输到手机端。
 */

import { z } from "zod";

// ---------- 归一化事件流 ----------

export const AgentEventSchema = z.discriminatedUnion("type", [
  /** 增量文本输出 */
  z.object({ type: z.literal("text"), text: z.string() }),
  /** 工具调用开始 */
  z.object({ type: z.literal("tool-call"), name: z.string(), summary: z.string() }),
  /** 工具调用结束 */
  z.object({ type: z.literal("tool-result"), name: z.string(), summary: z.string() }),
  /** 一轮对话结束 */
  z.object({ type: z.literal("turn-done"), reason: z.string() }),
  /** 错误 */
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

// ---------- 业务载荷（与 echo 并列，挂进 BusinessPayloadSchema） ----------

export const AgentEventPayloadSchema = z.object({
  kind: z.literal("agent-event"),
  sessionId: z.string(),
  agent: z.string(),
  event: AgentEventSchema,
});
export type AgentEventPayload = z.infer<typeof AgentEventPayloadSchema>;

export const PermissionRequestPayloadSchema = z.object({
  kind: z.literal("permission-request"),
  sessionId: z.string(),
  requestId: z.string(),
  agent: z.string(),
  toolName: z.string(),
  summary: z.string(),
  options: z.array(z.object({ id: z.string(), label: z.string() })),
});
export type PermissionRequestPayload = z.infer<typeof PermissionRequestPayloadSchema>;

export const PermissionResponsePayloadSchema = z.object({
  kind: z.literal("permission-response"),
  sessionId: z.string(),
  requestId: z.string(),
  optionId: z.string(),
});
export type PermissionResponsePayload = z.infer<typeof PermissionResponsePayloadSchema>;

export const UserInputPayloadSchema = z.object({
  kind: z.literal("user-input"),
  sessionId: z.string(),
  text: z.string(),
});
export type UserInputPayload = z.infer<typeof UserInputPayloadSchema>;
