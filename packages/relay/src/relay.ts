/**
 * Relay 核心逻辑（与 Bun.serve 解耦，便于单测）。
 *
 * 职责（刻意保持极简，服务器零知识）：
 * 1. 配对房间（nameplate 会合）：最多 2 人、5 分钟 TTL、转发握手消息
 * 2. 设备通道（token 寻址）：密文转发 + 离线缓冲（cap 100 条 / 24h TTL）
 * 3. 限频：配对加入按 IP 限频，防配对码在线爆破
 *
 * 不建用户库、不存明文、不碰业务密钥——被拖库也没有内容可泄。
 */

export interface Client {
  id: number;
  ip: string;
  send: (data: string) => void;
}

interface PairRoom {
  nameplate: string;
  clients: Client[];
  createdAt: number;
}

interface ChanBufferEntry {
  data: unknown;
  ts: number;
  /**
   * Which side queued it, by slot rather than object identity: a reconnect is a
   * new Client, so comparing objects still handed a client its own backlog.
   * Buffered frames used to go to whoever joined next, which both lost the
   * message and confused the receiver (it has no branch for its own kinds).
   */
  fromSlot: number;
}

interface Chan {
  token: string;
  members: Client[];
  buffer: ChanBufferEntry[];
  /**
   * Slot per live member, so a buffered frame is never handed back to the side
   * that queued it. Assigned by arrival, not by IP: both sides are 127.0.0.1 in
   * tests and share an address behind one NAT, which collapsed them onto one
   * slot. A reconnect gets whichever slot is free, which is the right answer
   * because the other side still holds its own.
   */
  slots: Map<Client, number>;
}

export class RateLimiter {
  private hits = new Map<string, number[]>();

  allow(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }

  /** Drop keys with no recent hits, so the map does not grow without bound. */
  sweep(windowMs: number): void {
    const now = Date.now();
    for (const [key, arr] of this.hits) {
      if (arr.every((t) => now - t >= windowMs)) this.hits.delete(key);
    }
  }
}

export interface RelayCoreOptions {
  pairTtlMs: number;
  pairLimitPerMin: number;
  pairMaxClients: number;
  chanMaxMembers: number;
  chanBufferCap: number;
  chanBufferTtlMs: number;
  pairDataMaxBytes: number;
  chanDataMaxBytes: number;
}

export const DEFAULT_OPTIONS: RelayCoreOptions = {
  pairTtlMs: 5 * 60_000,
  pairLimitPerMin: 30,
  pairMaxClients: 2,
  chanMaxMembers: 2,
  chanBufferCap: 100,
  chanBufferTtlMs: 24 * 3600_000,
  pairDataMaxBytes: 16_384,
  chanDataMaxBytes: 262_144,
};

const err = (code: string, message: string) => JSON.stringify({ op: "error", code, message });

export class RelayCore {
  private pairRooms = new Map<string, PairRoom>();
  private chans = new Map<string, Chan>();
  private meta = new Map<Client, { nameplate?: string; token?: string; slot?: number }>();
  readonly limiter = new RateLimiter();

  constructor(private readonly opts: RelayCoreOptions = DEFAULT_OPTIONS) {}

  handleClose(client: Client): void {
    const m = this.meta.get(client);
    if (m?.nameplate) this.leavePairRoom(client, m.nameplate);
    if (m?.token) {
      const chan = this.chans.get(m.token);
      if (chan) {
        chan.members = chan.members.filter((c) => c !== client);
        // Release the slot so a reconnect can claim it; holding it would leave
        // no free slot for the third connection.
        chan.slots.delete(client);
      }
    }
    this.meta.delete(client);
  }

  handleMessage(client: Client, raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return client.send(err("bad-json", "无法解析的消息"));
    }
    switch (msg?.op) {
      case "join-pair":
        return this.joinPair(client, msg);
      case "leave-pair":
        return this.leavePair(client);
      case "pair-data":
        return this.pairData(client, msg);
      case "join-chan":
        return this.joinChan(client, msg);
      case "chan-data":
        return this.chanData(client, msg);
      default:
        return client.send(err("unknown-op", "未知操作"));
    }
  }

  /** 定期清理：过期配对房间 + 通道缓冲超龄消息 */
  sweep(): void {
    const now = Date.now();
    for (const [nameplate, room] of this.pairRooms) {
      if (now - room.createdAt > this.opts.pairTtlMs) {
        room.clients.forEach((c) => c.send(err("pair-expired", "配对码已过期，请重新生成")));
        this.pairRooms.delete(nameplate);
      }
    }
    for (const [token, chan] of this.chans) {
      chan.buffer = chan.buffer.filter((e) => now - e.ts < this.opts.chanBufferTtlMs);
      // Reap fully idle channels: only clearing buffers left one Chan object per
      // token ever seen, which a public relay can be made to mint at will.
      if (chan.members.length === 0 && chan.buffer.length === 0) this.chans.delete(token);
    }
    this.limiter.sweep(60_000);
  }

  // ---------- 配对房间 ----------

  private joinPair(client: Client, msg: { nameplate?: unknown }): void {
    if (!this.limiter.allow(`pair:${client.ip}`, this.opts.pairLimitPerMin, 60_000)) {
      return client.send(err("rate-limited", "操作过于频繁，请稍后再试"));
    }
    const nameplate = String(msg.nameplate ?? "");
    if (!/^\d{4}$/.test(nameplate)) {
      return client.send(err("bad-nameplate", "房间号格式不正确"));
    }
    let room = this.pairRooms.get(nameplate);
    if (!room) {
      room = { nameplate, clients: [], createdAt: Date.now() };
      this.pairRooms.set(nameplate, room);
    }
    if (room.clients.includes(client)) return;
    if (room.clients.length >= this.opts.pairMaxClients) {
      return client.send(err("room-full", "配对房间已满或配对码已被使用"));
    }
    room.clients.push(client);
    this.meta.set(client, { ...this.meta.get(client), nameplate });
    client.send(JSON.stringify({ op: "pair-joined", role: room.clients.length === 1 ? "A" : "B" }));
    if (room.clients.length === this.opts.pairMaxClients) {
      room.clients.forEach((c) => c.send(JSON.stringify({ op: "pair-ready" })));
    }
  }

  private leavePair(client: Client): void {
    const m = this.meta.get(client);
    if (m?.nameplate) {
      this.leavePairRoom(client, m.nameplate);
      this.meta.set(client, { ...m, nameplate: undefined });
    }
  }

  private leavePairRoom(client: Client, nameplate: string): void {
    const room = this.pairRooms.get(nameplate);
    if (!room) return;
    room.clients = room.clients.filter((c) => c !== client);
    if (room.clients.length === 0) this.pairRooms.delete(nameplate);
    else room.clients.forEach((c) => c.send(JSON.stringify({ op: "pair-peer-left" })));
  }

  private pairData(client: Client, msg: { data?: unknown }): void {
    const m = this.meta.get(client);
    if (!m?.nameplate) return client.send(err("not-in-room", "尚未加入配对房间"));
    const room = this.pairRooms.get(m.nameplate);
    if (!room) return client.send(err("room-gone", "配对房间已过期"));
    if (JSON.stringify(msg.data ?? null).length > this.opts.pairDataMaxBytes) {
      return client.send(err("too-large", "配对消息过大"));
    }
    for (const c of room.clients) {
      if (c !== client) c.send(JSON.stringify({ op: "pair-data", data: msg.data }));
    }
  }

  // ---------- 设备通道 ----------

  private joinChan(client: Client, msg: { token?: unknown }): void {
    // Metered like join-pair: unmetered, a single connection could mint an
    // unbounded number of permanent channels with random tokens.
    if (!this.limiter.allow(`chan:${client.ip}`, this.opts.pairLimitPerMin, 60_000)) {
      return client.send(err("rate-limited", "操作过于频繁，请稍后再试"));
    }
    const token = String(msg.token ?? "");
    if (token.length < 16 || token.length > 128) {
      return client.send(err("bad-token", "通道令牌格式不正确"));
    }
    let chan = this.chans.get(token);
    if (!chan) {
      chan = { token, members: [], buffer: [], slots: new Map() };
      this.chans.set(token, chan);
    }
    if (!chan.members.includes(client)) {
      if (chan.members.length >= this.opts.chanMaxMembers) {
        return client.send(err("chan-full", "通道已满"));
      }
      chan.members.push(client);
    }
    // Take the free slot before draining the buffer. With at most two members,
    // "the slot nobody else holds" identifies this side unambiguously.
    let slot = chan.slots.get(client);
    if (slot === undefined) {
      const taken = new Set([...chan.slots.values()]);
      slot = taken.has(0) ? 1 : 0;
      chan.slots.set(client, slot);
    }
    this.meta.set(client, { ...this.meta.get(client), token, slot });
    client.send(JSON.stringify({ op: "chan-joined", peers: chan.members.length }));
    // 补发离线缓冲 — only what someone *else* queued, and only that is drained.
    // Handing a client its own backlog both lost the message and confused the
    // receiver, which has no branch for its own outbound kinds.
    const now = Date.now();
    const deliver: ChanBufferEntry[] = [];
    const keep: ChanBufferEntry[] = [];
    for (const e of chan.buffer) {
      if (now - e.ts >= this.opts.chanBufferTtlMs) continue;
      (e.fromSlot === slot ? keep : deliver).push(e);
    }
    chan.buffer = keep;
    for (const e of deliver) {
      client.send(JSON.stringify({ op: "chan-data", data: e.data, buffered: true }));
    }
  }

  private chanData(client: Client, msg: { data?: unknown }): void {
    const m = this.meta.get(client);
    if (!m?.token) return client.send(err("not-in-chan", "尚未加入通道"));
    const chan = this.chans.get(m.token);
    if (!chan) return client.send(err("chan-gone", "通道不存在"));
    if (JSON.stringify(msg.data ?? null).length > this.opts.chanDataMaxBytes) {
      return client.send(err("too-large", "消息过大"));
    }
    const others = chan.members.filter((c) => c !== client);
    if (others.length === 0) {
      chan.buffer.push({ data: msg.data, ts: Date.now(), fromSlot: m.slot ?? 0 });
      if (chan.buffer.length > this.opts.chanBufferCap) chan.buffer.shift();
      return;
    }
    for (const c of others) c.send(JSON.stringify({ op: "chan-data", data: msg.data }));
  }
}
