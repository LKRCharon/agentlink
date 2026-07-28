/**
 * 线上协议 schema（zod）。单一事实来源：daemon / app / relay 共用，
 * 只增不改，保持向后兼容（happy-wire 的教训：schema 复制三份必然漂移）。
 */

import { z } from "zod";
import {
  AgentEventPayloadSchema,
  PermissionRequestPayloadSchema,
  PermissionResponsePayloadSchema,
  UserInputPayloadSchema,
} from "./agent";

export const DeviceInfoSchema = z.object({
  name: z.string(),
  platform: z.string(),
});
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

// ---------- 配对握手（经 relay 配对房间转发，内容为公开值/标签） ----------

export const PairHelloSchema = z.object({
  v: z.literal(1),
  kind: z.literal("hello"),
  role: z.enum(["A", "B"]),
  ephPub: z.string(),
  device: DeviceInfoSchema,
});
export type PairHello = z.infer<typeof PairHelloSchema>;

export const PairConfirmSchema = z.object({
  v: z.literal(1),
  kind: z.literal("confirm"),
  tag: z.string(),
});
export type PairConfirm = z.infer<typeof PairConfirmSchema>;

export const PairIdentityWireSchema = z.object({
  v: z.literal(1),
  kind: z.literal("identity"),
  blob: z.string(), // SecureChannel(channelKey) 密封的 PairIdentityPayload
});
export type PairIdentityWire = z.infer<typeof PairIdentityWireSchema>;

/** 身份交换的明文内载荷（永远在配对会话密钥下加密传输） */
export const PairIdentityPayloadSchema = z.object({
  v: z.literal(1),
  kind: z.literal("identity"),
  identityPub: z.string(),
  device: DeviceInfoSchema,
});
export type PairIdentityPayload = z.infer<typeof PairIdentityPayloadSchema>;

export const PairAbortSchema = z.object({
  v: z.literal(1),
  kind: z.literal("abort"),
});
export type PairAbort = z.infer<typeof PairAbortSchema>;

export const PairWireMessageSchema = z.discriminatedUnion("kind", [
  PairHelloSchema,
  PairConfirmSchema,
  PairIdentityWireSchema,
  PairAbortSchema,
]);
export type PairWireMessage = z.infer<typeof PairWireMessageSchema>;

// ---------- 业务载荷（longTermKey 密封，经设备通道传输） ----------

export const EchoPayloadSchema = z.object({
  kind: z.literal("echo"),
  text: z.string(),
  sentAt: z.number(),
});
export type EchoPayload = z.infer<typeof EchoPayloadSchema>;

export const EchoAckPayloadSchema = z.object({
  kind: z.literal("echo-ack"),
  text: z.string(),
  sentAt: z.number(),
  from: DeviceInfoSchema,
});
export type EchoAckPayload = z.infer<typeof EchoAckPayloadSchema>;

export const BusinessPayloadSchema = z.discriminatedUnion("kind", [
  EchoPayloadSchema,
  EchoAckPayloadSchema,
  AgentEventPayloadSchema,
  PermissionRequestPayloadSchema,
  PermissionResponsePayloadSchema,
  UserInputPayloadSchema,
]);
export type BusinessPayload = z.infer<typeof BusinessPayloadSchema>;

// ---------- 设备通道消息外壳 ----------

export const ChanMessageSchema = z.object({
  v: z.literal(1),
  enc: z.string(), // SecureChannel(longTermKey) 密封的 BusinessPayload
});
export type ChanMessage = z.infer<typeof ChanMessageSchema>;
