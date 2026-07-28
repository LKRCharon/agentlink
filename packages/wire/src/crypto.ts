/**
 * 密码学原语（Bun / Node / 浏览器通用）：
 * - X25519：设备身份密钥与配对临时密钥的 DH 协商（@noble/curves）
 * - HKDF-SHA256 / HMAC-SHA256：密钥派生与握手确认（@noble/hashes）
 * - AES-256-GCM：业务载荷加密（WebCrypto，二进制布局对齐 happy 的 dataKey 变体）
 *
 * 密钥层级：
 *   配对码 secret → pepper（不过 relay）
 *   配对 ephemeral DH → shared → confirmKey(配 pepper) / channelKey(配对会话)
 *   设备身份 DH（首配完成后）→ longTermKey（持久化，等价 Syncthing 设备互信）
 *   longTermKey → chanToken（relay 设备通道令牌）/ SecureChannel 业务密钥
 */

import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { base32Encode } from "./code";

export interface KeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

const te = new TextEncoder();
const td = new TextDecoder();
export const utf8 = (s: string): Uint8Array => te.encode(s);
export const fromUtf8 = (b: Uint8Array): string => td.decode(b);

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

/** TS 5.7+ TypedArray 泛型：WebCrypto 需要 ArrayBuffer-backed 视图 */
const toAB = (u: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(u);

export function generateKeyPair(): KeyPair {
  const secretKey = x25519.utils.randomPrivateKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export function dh(secretKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(secretKey, peerPublicKey);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** 递归排序 key 的确定性 JSON（两端各自计算握手 transcript 用） */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

export function transcriptHash(a: unknown, b: unknown): Uint8Array {
  return sha256(utf8(`${stableStringify(a)}|${stableStringify(b)}`));
}

export function pepperFromSecret(secret: string): Uint8Array {
  return sha256(utf8(`agentlink/pepper/v1:${secret}`));
}

export function deriveConfirmKey(shared: Uint8Array, pepper: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, pepper, "agentlink/confirm/v1", 32);
}

/** direction 防反射：A 发 "A2B"，B 发 "B2A" */
export function confirmTag(confirmKey: Uint8Array, direction: "A2B" | "B2A", transcript: Uint8Array): Uint8Array {
  return hmac(sha256, confirmKey, concatBytes(transcript, utf8(`:${direction}`)));
}

export function deriveChannelKey(shared: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, undefined, "agentlink/channel/v1", 32);
}

export function deriveLongTermKey(identityDh: Uint8Array): Uint8Array {
  return hkdf(sha256, identityDh, undefined, "agentlink/longterm/v1", 32);
}

export function deriveChanToken(longTermKey: Uint8Array): string {
  return b64encode(hkdf(sha256, longTermKey, undefined, "agentlink/chan-token/v1", 24));
}

/** 人类可读设备指纹：XXXX-XXXX-XXXX-XXXX-XXXX */
export function fingerprint(publicKey: Uint8Array): string {
  const s = base32Encode(sha256(publicKey).slice(0, 12)).slice(0, 20);
  return s.match(/.{1,4}/g)!.join("-");
}

// ---------- base64（跨运行时） ----------

const Buf = (globalThis as { Buffer?: any }).Buffer;

export function b64encode(bytes: Uint8Array): string {
  if (Buf) return Buf.from(bytes).toString("base64");
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function b64decode(s: string): Uint8Array {
  if (Buf) return new Uint8Array(Buf.from(s, "base64"));
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

// ---------- AES-256-GCM ----------
// 二进制布局（对齐 happy dataKey 变体）：[version(1)=0 | nonce(12) | ciphertext | authTag(16)]

async function aesKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey("raw", toAB(keyBytes), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function aesEncrypt(keyBytes: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  const nonce = randomBytes(12);
  const key = await aesKey(keyBytes);
  const params: { name: string; iv: Uint8Array<ArrayBuffer>; additionalData?: Uint8Array<ArrayBuffer> } = {
    name: "AES-GCM",
    iv: nonce,
  };
  if (aad) params.additionalData = toAB(aad);
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt(params, key, toAB(plaintext)));
  const out = new Uint8Array(1 + 12 + ct.length);
  out[0] = 0;
  out.set(nonce, 1);
  out.set(ct, 13);
  return out;
}

export async function aesDecrypt(keyBytes: Uint8Array, blob: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  if (blob.length < 1 + 12 + 16 || blob[0] !== 0) throw new Error("密文格式不正确");
  const key = await aesKey(keyBytes);
  const dparams: { name: string; iv: Uint8Array<ArrayBuffer>; additionalData?: Uint8Array<ArrayBuffer> } = {
    name: "AES-GCM",
    iv: toAB(blob.slice(1, 13)),
  };
  if (aad) dparams.additionalData = toAB(aad);
  const pt = await globalThis.crypto.subtle.decrypt(dparams, key, toAB(blob.slice(13)));
  return new Uint8Array(pt);
}

/** 业务通道：AES-256-GCM 密封 JSON 载荷 */
export class SecureChannel {
  constructor(private readonly key: Uint8Array) {}

  async seal(payload: unknown): Promise<string> {
    return b64encode(await aesEncrypt(this.key, utf8(JSON.stringify(payload))));
  }

  async open<T = unknown>(blob: string): Promise<T> {
    return JSON.parse(fromUtf8(await aesDecrypt(this.key, b64decode(blob)))) as T;
  }
}
