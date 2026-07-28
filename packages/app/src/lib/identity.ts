/**
 * 浏览器端身份与已配对设备管理（localStorage，M1.3 简化方案）。
 * 生产环境可换 IndexedDB + 加密存储。
 */

import {
  b64decode,
  b64encode,
  deriveLongTermKey,
  dh,
  fingerprint,
  generateKeyPair,
  type KeyPair,
} from "@agentlink/wire";

export interface StoredPeer {
  identityPub: string;
  fingerprint: string;
  deviceName: string;
  platform: string;
  longTermKey: string;
  pairedAt: number;
}

const IDENTITY_KEY = "agentlink:identity";
const PEERS_KEY = "agentlink:peers";

export function loadIdentity(): KeyPair {
  const raw = localStorage.getItem(IDENTITY_KEY);
  if (raw) {
    try {
      const j = JSON.parse(raw);
      return { secretKey: b64decode(j.secretKey), publicKey: b64decode(j.publicKey) };
    } catch {
      // 损坏的数据，重新生成
    }
  }
  const kp = generateKeyPair();
  localStorage.setItem(
    IDENTITY_KEY,
    JSON.stringify({
      secretKey: b64encode(kp.secretKey),
      publicKey: b64encode(kp.publicKey),
      createdAt: Date.now(),
    }),
  );
  return kp;
}

export function getFingerprint(identity: KeyPair): string {
  return fingerprint(identity.publicKey);
}

export function loadPeers(): Record<string, StoredPeer> {
  try {
    return JSON.parse(localStorage.getItem(PEERS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function savePeer(peer: StoredPeer): void {
  const peers = loadPeers();
  peers[peer.fingerprint] = peer;
  localStorage.setItem(PEERS_KEY, JSON.stringify(peers));
}

export function removePeer(fingerprint: string): void {
  const peers = loadPeers();
  delete peers[fingerprint];
  localStorage.setItem(PEERS_KEY, JSON.stringify(peers));
}

export function getLatestPeer(): StoredPeer | null {
  const peers = Object.values(loadPeers());
  if (peers.length === 0) return null;
  return peers.sort((a, b) => b.pairedAt - a.pairedAt)[0];
}

/** 从配对结果 + 自身身份派生长期密钥并保存 peer */
export function finalizePeer(
  identity: KeyPair,
  result: {
    peerIdentityPub: Uint8Array;
    peerDevice: { name: string; platform: string };
    peerFingerprint: string;
  },
): Uint8Array {
  const longTermKey = deriveLongTermKey(dh(identity.secretKey, result.peerIdentityPub));
  savePeer({
    identityPub: b64encode(result.peerIdentityPub),
    fingerprint: result.peerFingerprint,
    deviceName: result.peerDevice.name,
    platform: result.peerDevice.platform,
    longTermKey: b64encode(longTermKey),
    pairedAt: Date.now(),
  });
  return longTermKey;
}
