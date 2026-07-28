import { afterAll, describe, expect, test } from "bun:test";
import { createRelayServer } from "../src/server";

const server = createRelayServer(0);
const url = `ws://127.0.0.1:${server.port}/ws`;

afterAll(() => server.stop());

type Msg = Record<string, unknown> & { op?: string };

interface TestClient {
  send: (obj: Msg) => void;
  wait: (pred: (m: Msg) => boolean, timeoutMs?: number) => Promise<Msg>;
  close: () => void;
}

async function connect(): Promise<TestClient> {
  const queue: Msg[] = [];
  const waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const sock = new WebSocket(url);
    sock.onopen = () => resolve(sock);
    sock.onerror = () => reject(new Error("connect failed"));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as Msg;
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) {
      const [w] = waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      queue.push(msg);
    }
  };
  return {
    send: (obj) => ws.send(JSON.stringify(obj)),
    wait: (pred, timeoutMs = 5_000) => {
      const qi = queue.findIndex(pred);
      if (qi >= 0) return Promise.resolve(queue.splice(qi, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("等待响应超时")), timeoutMs);
        waiters.push({ pred, resolve, timer });
      });
    },
    close: () => ws.close(),
  };
}

describe("relay", () => {
  test("配对房间：双方会合 + 消息转发 + 满员拒绝", async () => {
    const a = await connect();
    const b = await connect();
    a.send({ op: "join-pair", nameplate: "1234" });
    expect((await a.wait((m) => m.op === "pair-joined")).role).toBe("A");
    b.send({ op: "join-pair", nameplate: "1234" });
    expect((await b.wait((m) => m.op === "pair-joined")).role).toBe("B");
    await a.wait((m) => m.op === "pair-ready");
    await b.wait((m) => m.op === "pair-ready");

    a.send({ op: "pair-data", data: { hello: 1 } });
    expect((await b.wait((m) => m.op === "pair-data")).data).toEqual({ hello: 1 });

    const c = await connect();
    c.send({ op: "join-pair", nameplate: "1234" });
    expect((await c.wait((m) => m.op === "error")).code).toBe("room-full");

    a.close();
    b.close();
    c.close();
  });

  test("配对房间：错误房间号被拒绝", async () => {
    const c = await connect();
    c.send({ op: "join-pair", nameplate: "abc" });
    expect((await c.wait((m) => m.op === "error")).code).toBe("bad-nameplate");
    c.close();
  });

  test("设备通道：离线缓冲补发 + 在线转发", async () => {
    const token = "test-token-1234567890abcdef";
    const b = await connect();
    b.send({ op: "join-chan", token });
    await b.wait((m) => m.op === "chan-joined");
    // 对方不在线 → 进缓冲
    b.send({ op: "chan-data", data: { msg: "offline-hello" } });

    const a = await connect();
    a.send({ op: "join-chan", token });
    await a.wait((m) => m.op === "chan-joined");
    const buffered = await a.wait((m) => m.op === "chan-data");
    expect(buffered.data).toEqual({ msg: "offline-hello" });
    expect(buffered.buffered).toBe(true);

    // 双方在线 → 直接转发
    a.send({ op: "chan-data", data: { msg: "reply" } });
    expect((await b.wait((m) => m.op === "chan-data")).data).toEqual({ msg: "reply" });

    a.close();
    b.close();
  });

  test("health 端点", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
