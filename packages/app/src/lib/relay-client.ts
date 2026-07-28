/**
 * 浏览器端 relay 客户端：配对（B 方）+ 设备通道 + E2E 加密。
 * 复用 @agentlink/wire 的 PairingSession / SecureChannel / 配对码。
 */

import {
  PairingSession,
  SecureChannel,
  b64decode,
  b64encode,
  deriveChanToken,
  parsePairCode,
  type DeviceInfo,
  type KeyPair,
  type PairingResult,
} from "@agentlink/wire";
import { finalizePeer } from "./identity";

type Msg = Record<string, any>;

export type ConnectionStatus = "disconnected" | "connecting" | "pairing" | "channel-ready";

export interface PermissionRequest {
  sessionId: string;
  agent: string;
  requestId: string;
  toolName: string;
  summary: string;
  options: { id: string; label: string }[];
}

export interface AgentEvent {
  sessionId: string;
  agent: string;
  event: {
    type: string;
    text?: string;
    name?: string;
    summary?: string;
    reason?: string;
    message?: string;
  };
}

export class RelayClient {
  private ws: WebSocket | null = null;
  private queue: Msg[] = [];
  private waiters: {
    pred: (m: Msg) => boolean;
    resolve: (m: Msg) => void;
    timer: number;
  }[] = [];
  private chan: SecureChannel | null = null;

  onAgentEvent?: (e: AgentEvent) => void;
  onPermissionRequest?: (r: PermissionRequest) => void;
  onConnectionChange?: (status: ConnectionStatus) => void;

  constructor(private relayUrl: string) {}

  private send(obj: Msg): void {
    this.ws?.send(JSON.stringify(obj));
  }

  private dispatch(raw: string): void {
    let msg: Msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const i = this.waiters.findIndex((w) => {
      try {
        return w.pred(msg);
      } catch {
        return false;
      }
    });
    if (i >= 0) {
      const [w] = this.waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(msg);
      return;
    }
    if (msg.op === "chan-data" && this.chan) {
      void this.handleChanData(msg);
    } else {
      this.queue.push(msg);
    }
  }

  private async handleChanData(msg: Msg): Promise<void> {
    try {
      const payload = await this.chan!.open<any>(msg.data?.enc);
      if (payload?.kind === "agent-event") {
        this.onAgentEvent?.({
          sessionId: payload.sessionId,
          agent: payload.agent,
          event: payload.event,
        });
      } else if (payload?.kind === "permission-request") {
        this.onPermissionRequest?.({
          sessionId: payload.sessionId,
          agent: payload.agent,
          requestId: payload.requestId,
          toolName: payload.toolName,
          summary: payload.summary,
          options: payload.options,
        });
      }
    } catch {
      // 解密失败，忽略
    }
  }

  private wait(pred: (m: Msg) => boolean, timeoutMs = 15000): Promise<Msg> {
    const qi = this.queue.findIndex(pred);
    if (qi >= 0) return Promise.resolve(this.queue.splice(qi, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.resolve === resolve);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error("等待 relay 响应超时"));
      }, timeoutMs);
      this.waiters.push({ pred, resolve, timer });
    });
  }

  /** 配对（B 方）：输入码 → 握手 → 保存 peer → 自动进入设备通道 */
  async pair(codeStr: string, identity: KeyPair, device: DeviceInfo): Promise<PairingResult> {
    const code = parsePairCode(codeStr);
    this.onConnectionChange?.("connecting");
    this.ws = await this.connect();
    this.onConnectionChange?.("pairing");

    this.send({ op: "join-pair", nameplate: code.nameplate });
    const joined = await this.wait((m) => m.op === "pair-joined" || m.op === "error");
    if (joined.op === "error") throw new Error(joined.message ?? joined.code);
    if (joined.role !== "B") throw new Error("未找到等待中的配对发起方，请先在开发机运行 pair");

    const session = new PairingSession({ role: "B", secret: code.secret, identity, device });
    for (;;) {
      const msg = await this.wait((m) => m.op === "pair-data" || m.op === "pair-peer-left" || m.op === "error");
      if (msg.op === "pair-peer-left") throw new Error("对端已离开配对房间");
      if (msg.op === "error") throw new Error(msg.message ?? msg.code);
      const { replies, result } = await session.handle(msg.data);
      for (const r of replies) this.send({ op: "pair-data", data: r });
      if (result) {
        const longTermKey = finalizePeer(identity, result);
        this.send({ op: "leave-pair" });
        await this.joinChannel(longTermKey);
        return result;
      }
    }
  }

  /** 已有配对设备时直接进入通道 */
  async connectChannel(longTermKeyB64: string): Promise<void> {
    const longTermKey = b64decode(longTermKeyB64);
    this.onConnectionChange?.("connecting");
    this.ws = await this.connect();
    await this.joinChannel(longTermKey);
  }

  private async connect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.relayUrl);
      const timer = window.setTimeout(() => reject(new Error("连接 relay 超时")), 10000);
      ws.onopen = () => {
        clearTimeout(timer);
        ws.onmessage = (ev) => this.dispatch(String(ev.data));
        ws.onclose = () => {
          this.onConnectionChange?.("disconnected");
        };
        resolve(ws);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("无法连接 relay"));
      };
    });
  }

  private async joinChannel(longTermKey: Uint8Array): Promise<void> {
    const token = deriveChanToken(longTermKey);
    this.chan = new SecureChannel(longTermKey);
    this.send({ op: "join-chan", token });
    const res = await this.wait((m) => m.op === "chan-joined" || m.op === "error");
    if (res.op === "error") throw new Error(res.message ?? res.code);
    this.onConnectionChange?.("channel-ready");
  }

  async sendPermissionResponse(sessionId: string, requestId: string, optionId: string): Promise<void> {
    if (!this.chan) return;
    const enc = await this.chan.seal({ kind: "permission-response", sessionId, requestId, optionId });
    this.send({ op: "chan-data", data: { enc } });
  }

  async sendUserInput(sessionId: string, text: string): Promise<void> {
    if (!this.chan) return;
    const enc = await this.chan.seal({ kind: "user-input", sessionId, text });
    this.send({ op: "chan-data", data: { enc } });
  }

  disconnect(): void {
    try {
      this.ws?.close();
    } catch {
      // 忽略
    }
    this.ws = null;
    this.chan = null;
    this.onConnectionChange?.("disconnected");
  }
}
