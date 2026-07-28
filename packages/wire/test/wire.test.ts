import { describe, expect, test } from "bun:test";
import {
  PairingSession,
  SecureChannel,
  base32Decode,
  base32Encode,
  constantTimeEqual,
  dh,
  fingerprint,
  generateKeyPair,
  generatePairCode,
  parsePairCode,
  randomBytes,
  type PairWireMessage,
  type PairingResult,
} from "../src";

describe("配对码", () => {
  test("生成与解析往返", () => {
    const c = generatePairCode();
    expect(c.display).toMatch(/^\d{4}-[0-9A-Z]{6}$/);
    const p = parsePairCode(c.display);
    expect(p.nameplate).toBe(c.nameplate);
    expect(p.secret).toBe(c.secret);
  });

  test("容忍小写、空格、缺横线与混淆字符", () => {
    const c = generatePairCode();
    const messy = `${c.nameplate} ${c.secret.toLowerCase().replace(/1/g, "l").replace(/0/g, "o")}`;
    const p = parsePairCode(messy);
    expect(p.secret).toBe(c.secret);
  });

  test("非法输入抛错", () => {
    expect(() => parsePairCode("hello")).toThrow();
    expect(() => parsePairCode("12345-ABCDEF")).toThrow();
  });

  test("base32 往返", () => {
    const data = randomBytes(10);
    expect(base32Decode(base32Encode(data))).toEqual(data);
  });
});

describe("加密原语", () => {
  test("X25519 双方共享密钥一致", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    expect(constantTimeEqual(dh(a.secretKey, b.publicKey), dh(b.secretKey, a.publicKey))).toBe(true);
  });

  test("SecureChannel 密封/解开往返", async () => {
    const chan = new SecureChannel(randomBytes(32));
    const payload = { kind: "echo", text: "你好 agentlink", sentAt: Date.now() };
    const blob = await chan.seal(payload);
    expect(await chan.open<typeof payload>(blob)).toEqual(payload);
  });

  test("错误密钥解密失败", async () => {
    const a = new SecureChannel(randomBytes(32));
    const b = new SecureChannel(randomBytes(32));
    const blob = await a.seal({ x: 1 });
    await expect(b.open(blob)).rejects.toThrow();
  });

  test("指纹格式", () => {
    const kp = generateKeyPair();
    expect(fingerprint(kp.publicKey)).toMatch(/^([0-9A-Z]{4}-){4}[0-9A-Z]{4}$/);
  });
});

describe("配对握手", () => {
  /** 内存回路：把 from 产出的消息依次喂给 to，递归驱动直到完成 */
  async function pump(
    from: PairingSession,
    to: PairingSession,
    msg: PairWireMessage,
    sink: { a?: PairingResult; b?: PairingResult },
    names: { from: "a" | "b"; to: "a" | "b" },
  ): Promise<void> {
    const { replies, result } = await to.handle(msg);
    if (result) sink[names.to] = result;
    for (const r of replies) {
      await pump(to, from, r, sink, { from: names.to, to: names.from });
    }
  }

  test("端到端完成且密钥一致", async () => {
    const code = generatePairCode();
    const aId = generateKeyPair();
    const bId = generateKeyPair();
    const A = new PairingSession({ role: "A", secret: code.secret, identity: aId, device: { name: "mac", platform: "darwin" } });
    const B = new PairingSession({ role: "B", secret: code.secret, identity: bId, device: { name: "phone", platform: "ios" } });
    const sink: { a?: PairingResult; b?: PairingResult } = {};
    await pump(A, B, A.start(), sink, { from: "a", to: "b" });

    expect(sink.a).toBeDefined();
    expect(sink.b).toBeDefined();
    expect(sink.a!.peerFingerprint).toBe(fingerprint(bId.publicKey));
    expect(sink.b!.peerFingerprint).toBe(fingerprint(aId.publicKey));
    expect(constantTimeEqual(sink.a!.channelKey, sink.b!.channelKey)).toBe(true);

    // 配对会话密钥可正常加密通信
    const chanA = new SecureChannel(sink.a!.channelKey);
    const chanB = new SecureChannel(sink.b!.channelKey);
    const blob = await chanA.seal({ hello: "world" });
    expect(await chanB.open<{ hello: string }>(blob)).toEqual({ hello: "world" });
  });

  test("密钥确认失败：两侧 secret 不一致（中间人场景）", async () => {
    const aId = generateKeyPair();
    const bId = generateKeyPair();
    const A = new PairingSession({ role: "A", secret: "AAAAAA", identity: aId, device: { name: "mac", platform: "darwin" } });
    const B = new PairingSession({ role: "B", secret: "BBBBBB", identity: bId, device: { name: "phone", platform: "ios" } });
    const sink: { a?: PairingResult; b?: PairingResult } = {};
    await expect(pump(A, B, A.start(), sink, { from: "a", to: "b" })).rejects.toThrow(/密钥确认失败/);
    expect(sink.a).toBeUndefined();
    expect(sink.b).toBeUndefined();
  });
});
