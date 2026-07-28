/**
 * 配对码：NNNN-XXXXXX
 * - NNNN：4 位数字 nameplate，仅用于在 relay 上定位会合房间（公开信息）
 * - XXXXXX：6 个 Crockford base32 字符（30 bit 熵），作为密钥确认的 pepper，
 *   永不离开两端设备，relay 不可见
 *
 * 安全模型：一次性 + TTL + relay 限频；中间人每次会话仅有 1 次在线猜测机会
 * （1/2^30），猜错即被两端察觉（参考 magic-wormhole 的 PAKE 安全叙事）。
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const REV: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) REV[ALPHABET[i]] = i;
// Crockford 别名归一
REV["I"] = 1;
REV["L"] = 1;
REV["O"] = 0;

export function base32Encode(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[-\s]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const v = REV[ch];
    if (v === undefined) throw new Error(`非法 base32 字符: ${ch}`);
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export interface PairCode {
  /** 4 位数字，relay 会合房间号（公开） */
  nameplate: string;
  /** 6 个 base32 字符，密钥确认 pepper（保密，不过 relay） */
  secret: string;
  /** 展示形态 NNNN-XXXXXX */
  display: string;
}

export function generatePairCode(rand?: () => Uint8Array): PairCode {
  const nameplate = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  const bytes = rand ?? (() => {
    const b = new Uint8Array(4);
    globalThis.crypto.getRandomValues(b);
    return b;
  });
  const secret = base32Encode(bytes()).slice(0, 6);
  return { nameplate, secret, display: `${nameplate}-${secret}` };
}

/** 解析并规范化用户输入（容忍小写、空格、缺横线、I/L/O 混淆字符） */
export function parsePairCode(input: string): PairCode {
  const clean = input.trim().toUpperCase().replace(/\s+/g, "");
  const m = clean.match(/^(\d{4})-?([0-9A-Z]{6})$/);
  if (!m) throw new Error("配对码格式不正确，应为 NNNN-XXXXXX");
  const [, nameplate, secretRaw] = m;
  const secret = [...secretRaw]
    .map((ch) => {
      const v = REV[ch];
      if (v === undefined) throw new Error(`配对码包含非法字符: ${ch}`);
      return ALPHABET[v];
    })
    .join("");
  return { nameplate, secret, display: `${nameplate}-${secret}` };
}
