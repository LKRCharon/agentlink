/**
 * 配对握手状态机（传输无关，daemon / app 两侧复用）：
 *
 *   A（发起方，展示配对码）          B（加入方，输入配对码）
 *        │ ───── hello(A) ───────────▶ │
 *        │ ◀── hello(B)+confirm(B)+identity(B) ── │
 *        │ ─── confirm(A)+identity(A) ▶ │
 *        双方完成 → PairingResult
 *
 * - confirm = HMAC(confirmKey, transcript + direction)，confirmKey 混入配对码
 *   pepper：不知道配对码的中间人无法伪造，每次会话仅 1 次在线猜测机会
 * - identity 内载荷在配对会话密钥 channelKey 下加密，relay 全程零知识
 */

import {
  SecureChannel,
  b64decode,
  b64encode,
  confirmTag,
  constantTimeEqual,
  deriveChannelKey,
  deriveConfirmKey,
  dh,
  fingerprint,
  generateKeyPair,
  pepperFromSecret,
  stableStringify,
  transcriptHash,
  type KeyPair,
} from "./crypto";
import {
  PairConfirmSchema,
  PairHelloSchema,
  PairIdentityPayloadSchema,
  type DeviceInfo,
  type PairHello,
  type PairIdentityPayload,
  type PairWireMessage,
} from "./schema";

export class PairingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PairingError";
  }
}

export interface PairingResult {
  /** 配对会话密钥（仅本次配对过程使用，不持久化） */
  channelKey: Uint8Array;
  peerIdentityPub: Uint8Array;
  peerDevice: DeviceInfo;
  peerFingerprint: string;
}

export interface PairingSessionOptions {
  role: "A" | "B";
  /** 配对码的 secret 部分（6 字符，不过 relay） */
  secret: string;
  identity: KeyPair;
  device: DeviceInfo;
}

export class PairingSession {
  private readonly opts: PairingSessionOptions;
  private readonly eph: KeyPair;
  private readonly pepper: Uint8Array;
  private readonly helloMsg: PairHello;

  private channelKey?: Uint8Array;
  private confirmKey?: Uint8Array;
  private transcript?: Uint8Array;
  private chan?: SecureChannel;
  private peerIdentity?: PairIdentityPayload;
  private finished = false;

  constructor(opts: PairingSessionOptions) {
    this.opts = opts;
    this.eph = generateKeyPair();
    this.pepper = pepperFromSecret(opts.secret);
    this.helloMsg = {
      v: 1,
      kind: "hello",
      role: opts.role,
      ephPub: b64encode(this.eph.publicKey),
      device: opts.device,
    };
  }

  /** A 方在 pair-ready 后发送的首条消息（B 方不主动发，等 A 的 hello） */
  start(): PairWireMessage {
    return this.helloMsg;
  }

  async handle(raw: unknown): Promise<{ replies: PairWireMessage[]; result?: PairingResult }> {
    if (this.finished) throw new PairingError("配对已完成，收到多余消息");
    const msg = raw as PairWireMessage;
    switch (msg.kind) {
      case "hello":
        return this.handleHello(msg);
      case "confirm":
        return this.handleConfirm(msg);
      case "identity":
        return this.handleIdentity(msg);
      case "abort":
        throw new PairingError("密钥确认失败（对端中止）：配对码错误或存在中间人攻击");
      default:
        throw new PairingError("未知的配对消息类型");
    }
  }

  private async handleHello(raw: PairWireMessage): Promise<{ replies: PairWireMessage[] }> {
    if (this.channelKey) throw new PairingError("重复收到 hello");
    const hello = PairHelloSchema.parse(raw);
    if (hello.role === this.opts.role) {
      throw new PairingError("配对角色冲突（两端都是同一角色）");
    }
    const shared = dh(this.eph.secretKey, b64decode(hello.ephPub));
    const helloA = this.opts.role === "A" ? this.helloMsg : hello;
    const helloB = this.opts.role === "A" ? hello : this.helloMsg;
    this.transcript = transcriptHash(stableStringify(helloA), stableStringify(helloB));
    this.confirmKey = deriveConfirmKey(shared, this.pepper);
    this.channelKey = deriveChannelKey(shared);
    this.chan = new SecureChannel(this.channelKey);

    const direction = this.opts.role === "A" ? "A2B" : "B2A";
    const confirm: PairWireMessage = {
      v: 1,
      kind: "confirm",
      tag: b64encode(confirmTag(this.confirmKey, direction, this.transcript)),
    };
    const replies: PairWireMessage[] = [];
    if (this.opts.role === "B") {
      // B 方一次性回齐 hello + confirm + identity，A 方先收到 hello 才能计算密钥
      replies.push(this.helloMsg, confirm, await this.identityMessage());
    } else {
      replies.push(confirm);
    }
    return { replies };
  }

  private async handleConfirm(raw: PairWireMessage): Promise<{ replies: PairWireMessage[]; result?: PairingResult }> {
    if (!this.confirmKey || !this.transcript) throw new PairingError("协议顺序错误");
    const confirm = PairConfirmSchema.parse(raw);
    const expectDir = this.opts.role === "A" ? "B2A" : "A2B";
    const expected = confirmTag(this.confirmKey, expectDir, this.transcript);
    if (!constantTimeEqual(expected, b64decode(confirm.tag))) {
      throw new PairingError("密钥确认失败：配对码错误或存在中间人攻击");
    }
    const replies: PairWireMessage[] = [];
    if (this.opts.role === "A") replies.push(await this.identityMessage());
    return { replies, result: this.tryFinish() };
  }

  private async handleIdentity(raw: PairWireMessage): Promise<{ replies: PairWireMessage[]; result?: PairingResult }> {
    if (!this.chan) throw new PairingError("协议顺序错误");
    const blob = (raw as { blob?: string }).blob;
    if (typeof blob !== "string") throw new PairingError("身份消息格式不正确");
    let payload: unknown;
    try {
      payload = await this.chan.open(blob);
    } catch {
      throw new PairingError("身份消息解密失败");
    }
    this.peerIdentity = PairIdentityPayloadSchema.parse(payload);
    return { replies: [], result: this.tryFinish() };
  }

  private async identityMessage(): Promise<PairWireMessage> {
    const payload: PairIdentityPayload = {
      v: 1,
      kind: "identity",
      identityPub: b64encode(this.opts.identity.publicKey),
      device: this.opts.device,
    };
    return { v: 1, kind: "identity", blob: await this.chan!.seal(payload) };
  }

  private tryFinish(): PairingResult | undefined {
    if (!this.peerIdentity || !this.channelKey) return undefined;
    this.finished = true;
    return {
      channelKey: this.channelKey,
      peerIdentityPub: b64decode(this.peerIdentity.identityPub),
      peerDevice: this.peerIdentity.device,
      peerFingerprint: fingerprint(b64decode(this.peerIdentity.identityPub)),
    };
  }
}
