/**
 * daemon 客户端核心：配对流程（A 方发起 / B 方加入）+ 设备通道 echo 服务。
 * M1.1 只打通链路，agent 适配层在 M1.2 接入。
 */

import { hostname } from "node:os";
import {
  PairingSession,
  SecureChannel,
  b64decode,
  b64encode,
  deriveChanToken,
  deriveLongTermKey,
  dh,
  generatePairCode,
  parsePairCode,
  type DeviceInfo,
  type KeyPair,
  type PairWireMessage,
  type PairingResult,
} from "@agentlink/wire";
import { listPeers, loadOrCreateIdentity, savePeer } from "./store";
import { CodexAdapter } from "./agent/codex";
import { QoderAdapter } from "./agent/qoder";
import { serveAgent } from "./agent/serve";

type Msg = Record<string, any>;

const relayUrl = () => process.env.AGENTLINK_RELAY ?? "ws://127.0.0.1:8787/ws";

// ---------- WebSocket 连接封装（消息等待队列） ----------

export class WsConn {
  private ws!: WebSocket;
  private queue: Msg[] = [];
  private waiters: {
    pred: (m: Msg) => boolean;
    resolve: (m: Msg) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  /** relay 断连回调（长跑 watch 用来上报/退出）；pending waiter 会同时被 reject */
  onClose?: () => void;

  private constructor() {}

  static async connect(url: string): Promise<WsConn> {
    const conn = new WsConn();
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => reject(new Error(`连接 relay 超时: ${url}`)), 10_000);
      ws.onopen = () => {
        clearTimeout(timer);
        conn.ws = ws;
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`无法连接 relay: ${url}`));
      };
      ws.onmessage = (ev) => conn.dispatch(String(ev.data));
      ws.onclose = () => conn.handleClose();
    });
    return conn;
  }

  private dispatch(raw: string) {
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
    } else {
      this.queue.push(msg);
    }
  }

  private handleClose() {
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error("relay 连接已断开"));
    }
    this.onClose?.();
  }

  send(obj: Msg) {
    this.ws.send(JSON.stringify(obj));
  }

  wait(pred: (m: Msg) => boolean, timeoutMs = 15_000): Promise<Msg> {
    const qi = this.queue.findIndex(pred);
    if (qi >= 0) return Promise.resolve(this.queue.splice(qi, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.resolve === resolve);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error("等待对端响应超时"));
      }, timeoutMs);
      this.waiters.push({ pred, resolve, reject, timer });
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // 忽略
    }
  }
}

// ---------- 配对与通道 ----------

function deviceInfo(): DeviceInfo {
  return { name: hostname(), platform: process.platform };
}

async function doPairing(conn: WsConn, session: PairingSession, role: "A" | "B"): Promise<PairingResult> {
  const sendWire = (m: PairWireMessage) => conn.send({ op: "pair-data", data: m });
  if (role === "A") {
    await conn.wait((m) => m.op === "pair-ready" || m.op === "pair-peer-left", 5 * 60_000).catch((e) => {
      throw new Error("等待对端加入超时（配对码已过期）");
    });
    sendWire(session.start());
  }
  for (;;) {
    const msg = await conn.wait((m) => m.op === "pair-data" || m.op === "pair-peer-left" || m.op === "error", 60_000);
    if (msg.op === "pair-peer-left") throw new Error("对端已离开配对房间");
    if (msg.op === "error") throw new Error(`relay 错误: ${msg.message ?? msg.code}`);
    try {
      const { replies, result } = await session.handle(msg.data);
      for (const r of replies) sendWire(r);
      if (result) return result;
    } catch (e) {
      // 校验失败时尽力通知对端，让两端都能快速失败（而不是傻等超时）
      try {
        sendWire({ v: 1, kind: "abort" });
      } catch {
        // 忽略
      }
      throw e;
    }
  }
}

/** 首配完成后：身份 DH → longTermKey → 落盘 */
function finalizePair(identity: KeyPair, result: PairingResult): Uint8Array {
  const longTermKey = deriveLongTermKey(dh(identity.secretKey, result.peerIdentityPub));
  savePeer({
    identityPub: b64encode(result.peerIdentityPub),
    fingerprint: result.peerFingerprint,
    deviceName: result.peerDevice.name,
    platform: result.peerDevice.platform,
    longTermKey: b64encode(longTermKey),
    pairedAt: Date.now(),
  });
  console.log(`配对成功: ${result.peerDevice.name} [${result.peerFingerprint}]`);
  return longTermKey;
}

export async function joinChan(conn: WsConn, longTermKey: Uint8Array): Promise<SecureChannel> {
  conn.send({ op: "join-chan", token: deriveChanToken(longTermKey) });
  const res = await conn.wait((m) => m.op === "chan-joined" || m.op === "error");
  if (res.op === "error") throw new Error(`进入设备通道失败: ${res.message ?? res.code}`);
  return new SecureChannel(longTermKey);
}

/** echo 应答循环（M1.1 的链路验证，M1.2 替换为 agent 事件流） */
async function serveChan(conn: WsConn, chan: SecureChannel, device: DeviceInfo): Promise<never> {
  console.log("已进入设备通道，等待手机端消息（Ctrl+C 退出）");
  for (;;) {
    const msg = await conn.wait((m) => m.op === "chan-data", 24 * 3600_000);
    try {
      const payload = await chan.open<any>(msg.data?.enc);
      if (payload?.kind === "echo") {
        conn.send({
          op: "chan-data",
          data: { enc: await chan.seal({ kind: "echo-ack", text: payload.text, sentAt: payload.sentAt, from: device }) },
        });
        console.log(`echo: ${payload.text}${msg.buffered ? "（离线补发）" : ""}`);
      }
    } catch {
      console.log("收到无法解密的消息，已忽略");
    }
  }
}

export interface RunPairOptions {
  onCode?: (display: string) => void;
  /** 配对完成后是否进入服务循环（测试时关闭） */
  serve?: boolean;
  /** 自定义服务循环（默认 echo 应答；M1.2 可挂 agent 桥接） */
  onServe?: (conn: WsConn, chan: SecureChannel) => Promise<void>;
  /** 结构化 stdout：供 Argus GUI 解析配对码与结果 */
  json?: boolean;
}

/** A 方：生成配对码并等待对端 */
export async function runPair(opts: RunPairOptions = {}): Promise<PairingResult> {
  const identity = loadOrCreateIdentity();
  const device = deviceInfo();
  const maxAttempts = 5;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = generatePairCode();
    const conn = await WsConn.connect(relayUrl());
    try {
      conn.send({ op: "join-pair", nameplate: code.nameplate });
      const joined = await conn.wait((m) => m.op === "pair-joined" || m.op === "error");
      if (joined.op === "error") {
        conn.close();
        if (joined.code === "room-full") continue;
        throw new Error(`relay 拒绝: ${joined.message ?? joined.code}`);
      }
      if (joined.role !== "A") {
        // 房间被占用（极端竞争），换个 nameplate 重试
        conn.close();
        continue;
      }
      opts.onCode?.(code.display);
      if (opts.json) {
        process.stdout.write(JSON.stringify({ type: "pair_code", code: code.display, ttlSeconds: 300 }) + "\n");
      }
      console.log(`配对码: ${code.display}（5 分钟内有效，等待对端输入…）`);
      const session = new PairingSession({ role: "A", secret: code.secret, identity, device });
      const result = await doPairing(conn, session, "A");
      const longTermKey = finalizePair(identity, result);
      if (opts.json) {
        process.stdout.write(JSON.stringify({
          type: "pair_done",
          deviceName: result.peerDevice.name,
          platform: result.peerDevice.platform,
          fingerprint: result.peerFingerprint,
        }) + "\n");
      }
      conn.send({ op: "leave-pair" });
      if (opts.serve !== false) {
        const chan = await joinChan(conn, longTermKey);
        const serve = opts.onServe ?? ((c: WsConn, ch: SecureChannel) => serveChan(c, ch, device));
        await serve(conn, chan);
      }
      conn.close();
      return result;
    } catch (e) {
      conn.close();
      throw e;
    }
  }
  throw new Error("多次分配配对房间失败，请重试");
}

export interface RunProbeOptions {
  echoText?: string;
  /** agent 演示模式：打印事件流，自动批准第一个权限选项 */
  agentDemo?: boolean;
}

/** B 方：输入配对码加入，完成后发一条 echo 验证链路（模拟手机端） */
export async function runProbe(codeStr: string, opts: RunProbeOptions = {}): Promise<{ rtt: number; agentDone?: boolean }> {
  const code = parsePairCode(codeStr);
  const identity = loadOrCreateIdentity();
  const device = deviceInfo();

  const conn = await WsConn.connect(relayUrl());
  try {
    conn.send({ op: "join-pair", nameplate: code.nameplate });
    const joined = await conn.wait((m) => m.op === "pair-joined" || m.op === "error");
    if (joined.op === "error") throw new Error(`relay 拒绝: ${joined.message ?? joined.code}`);
    if (joined.role !== "B") {
      throw new Error("未找到等待中的配对发起方（请先在开发机运行 pair，再输入配对码）");
    }
    const session = new PairingSession({ role: "B", secret: code.secret, identity, device });
    const result = await doPairing(conn, session, "B");
    const longTermKey = finalizePair(identity, result);
    conn.send({ op: "leave-pair" });

    const chan = await joinChan(conn, longTermKey);
    if (opts.agentDemo) {
      return await probeAgentDemo(conn, chan);
    }
    const text = opts.echoText ?? "hello";
    const t0 = Date.now();
    conn.send({ op: "chan-data", data: { enc: await chan.seal({ kind: "echo", text, sentAt: t0 }) } });
    for (;;) {
      const msg = await conn.wait((m) => m.op === "chan-data", 15_000);
      try {
        const payload = await chan.open<any>(msg.data?.enc);
        if (payload?.kind === "echo-ack" && payload.text === text) {
          const rtt = Date.now() - t0;
          console.log(`echo 打通，对端: ${payload.from?.name}，RTT: ${rtt}ms`);
          conn.close();
          return { rtt };
        }
      } catch {
        // 非本通道消息，忽略
      }
    }
  } catch (e) {
    conn.close();
    throw e;
  }
}

/** agent 演示：打印事件流，自动批准第一个权限选项 */
async function probeAgentDemo(conn: WsConn, chan: SecureChannel): Promise<{ rtt: number; agentDone: boolean }> {
  console.log("已进入 agent 演示模式：打印事件流，自动批准第一个权限选项");
  for (;;) {
    const msg = await conn.wait((m) => m.op === "chan-data", 60_000);
    let payload: any;
    try {
      payload = await chan.open(msg.data?.enc);
    } catch {
      continue;
    }
    if (payload?.kind === "agent-event") {
      const ev = payload.event;
      if (ev?.type === "text") {
        process.stdout.write(ev.text);
      } else {
        console.log(`\n[${payload.agent}] ${ev?.type}: ${ev?.summary ?? ev?.reason ?? ev?.message ?? ""}`);
      }
      if (ev?.type === "turn-done") {
        conn.close();
        return { rtt: -1, agentDone: true };
      }
    } else if (payload?.kind === "permission-request") {
      const opt = payload.options?.[0];
      console.log(`\n[审批] ${payload.toolName}: ${payload.summary} → 自动选择「${opt?.label ?? "拒绝"}」`);
      conn.send({
        op: "chan-data",
        data: {
          enc: await chan.seal({
            kind: "permission-response",
            sessionId: payload.sessionId,
            requestId: payload.requestId,
            optionId: opt?.id ?? "__deny__",
          }),
        },
      });
    }
  }
}

/** 启动 agent 会话并桥接到最近配对的设备（M1.2 核心命令） */
export async function runAgent(name: "qoder" | "codex", opts: { cwd: string; prompt?: string; model?: string }): Promise<void> {
  const peers = Object.values(listPeers());
  if (peers.length === 0) throw new Error("尚未配对任何设备，请先运行 pair");
  const peer = peers.sort((a, b) => b.pairedAt - a.pairedAt)[0];
  const adapter = name === "qoder" ? new QoderAdapter() : new CodexAdapter();
  const conn = await WsConn.connect(relayUrl());
  const longTermKey = b64decode(peer.longTermKey);
  const chan = await joinChan(conn, longTermKey);
  console.log(`已连接对端 ${peer.deviceName}，启动 ${name} 会话（${opts.cwd}）…`);
  await serveAgent(conn, chan, adapter, opts);
}

/** 常驻在线：使用已配对设备进入通道等待连接 */
export async function runUp(): Promise<void> {
  const peers = Object.values(listPeers());
  if (peers.length === 0) throw new Error("尚未配对任何设备，请先运行 pair");
  const peer = peers.sort((a, b) => b.pairedAt - a.pairedAt)[0];
  console.log(`上线，等待对端 ${peer.deviceName} [${peer.fingerprint}] 连接…`);
  const conn = await WsConn.connect(relayUrl());
  const longTermKey = b64decode(peer.longTermKey);
  const chan = await joinChan(conn, longTermKey);
  await serveChan(conn, chan, deviceInfo());
}
