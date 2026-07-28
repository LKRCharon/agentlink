/**
 * 本地持久化（~/.agentlink，可用 AGENTLINK_HOME 覆盖，测试用）：
 * - identity.json：设备身份密钥（mode 600）
 * - peers.json：已配对设备（fingerprint → 对端信息 + longTermKey，mode 600）
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { b64decode, b64encode, generateKeyPair, type KeyPair } from "@agentlink/wire";

export interface StoredPeer {
  identityPub: string;
  fingerprint: string;
  deviceName: string;
  platform: string;
  longTermKey: string;
  pairedAt: number;
}

export function configDir(): string {
  const dir = process.env.AGENTLINK_HOME ?? join(homedir(), ".agentlink");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  return dir;
}

function identityFile(): string {
  return join(configDir(), "identity.json");
}

function peersFile(): string {
  return join(configDir(), "peers.json");
}

export function loadOrCreateIdentity(): KeyPair {
  if (existsSync(identityFile())) {
    const j = JSON.parse(readFileSync(identityFile(), "utf8"));
    return { secretKey: b64decode(j.secretKey), publicKey: b64decode(j.publicKey) };
  }
  const kp = generateKeyPair();
  writeFileSync(
    identityFile(),
    JSON.stringify(
      { secretKey: b64encode(kp.secretKey), publicKey: b64encode(kp.publicKey), createdAt: Date.now() },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return kp;
}

export function listPeers(): Record<string, StoredPeer> {
  try {
    return JSON.parse(readFileSync(peersFile(), "utf8"));
  } catch {
    return {};
  }
}

export function savePeer(peer: StoredPeer): void {
  const peers = listPeers();
  peers[peer.fingerprint] = peer;
  writeFileSync(peersFile(), JSON.stringify(peers, null, 2), { mode: 0o600 });
}

/** 重命名已配对设备（仅本地显示名，不影响密钥与指纹） */
export function renamePeer(fingerprint: string, deviceName: string): boolean {
  const peers = listPeers();
  const peer = peers[fingerprint];
  if (!peer) return false;
  peers[fingerprint] = { ...peer, deviceName };
  writeFileSync(peersFile(), JSON.stringify(peers, null, 2), { mode: 0o600 });
  return true;
}

/** 移除已配对设备 */
export function removePeer(fingerprint: string): boolean {
  const peers = listPeers();
  if (!peers[fingerprint]) return false;
  delete peers[fingerprint];
  writeFileSync(peersFile(), JSON.stringify(peers, null, 2), { mode: 0o600 });
  return true;
}
