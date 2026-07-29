import { describe, expect, test } from "bun:test";
import { DEFAULT_OPTIONS, RelayCore, type Client } from "../src/relay";

/** Records what the relay sent to one side. */
function fakeClient(id: number, ip = "1.2.3.4"): Client & { sent: any[] } {
  const sent: any[] = [];
  return {
    id,
    ip,
    sent,
    send: (data: string) => {
      try {
        sent.push(JSON.parse(data));
      } catch {
        sent.push(data);
      }
    },
  };
}

const TOKEN = "0123456789abcdef0123";

describe("relay channel buffering", () => {
  test("a reconnecting client is not handed its own backlog", () => {
    // The bug: the buffer did not record who queued a frame, so it went to
    // whoever joined next. A phone that reconnected after a blip got its own
    // messages back — and since delivery drains the buffer, the daemon never
    // saw them at all.
    const core = new RelayCore();
    const phone = fakeClient(1);

    core.handleMessage(phone, JSON.stringify({ op: "join-chan", token: TOKEN }));
    core.handleMessage(phone, JSON.stringify({ op: "chan-data", data: { from: "phone" } }));

    // Phone drops and comes back.
    core.handleClose(phone);
    const phoneAgain = fakeClient(2);
    core.handleMessage(phoneAgain, JSON.stringify({ op: "join-chan", token: TOKEN }));

    const echoed = phoneAgain.sent.filter((m) => m.op === "chan-data");
    expect(echoed).toHaveLength(0);

    // And the message is still waiting for the other side.
    const mac = fakeClient(3, "5.6.7.8");
    core.handleMessage(mac, JSON.stringify({ op: "join-chan", token: TOKEN }));
    const delivered = mac.sent.filter((m) => m.op === "chan-data");
    expect(delivered).toHaveLength(1);
    expect(delivered[0].data).toEqual({ from: "phone" });
    expect(delivered[0].buffered).toBe(true);
  });

  test("the other side still receives what was buffered for it", () => {
    const core = new RelayCore();
    const mac = fakeClient(1, "5.6.7.8");
    core.handleMessage(mac, JSON.stringify({ op: "join-chan", token: TOKEN }));
    core.handleMessage(mac, JSON.stringify({ op: "chan-data", data: { event: 1 } }));

    const phone = fakeClient(2);
    core.handleMessage(phone, JSON.stringify({ op: "join-chan", token: TOKEN }));
    expect(phone.sent.filter((m) => m.op === "chan-data")).toHaveLength(1);
  });

  test("join-chan is rate limited", () => {
    // Unmetered, one connection could mint an unbounded number of channels.
    const core = new RelayCore({ ...DEFAULT_OPTIONS, pairLimitPerMin: 3 });
    const client = fakeClient(1);
    for (let i = 0; i < 5; i++) {
      core.handleMessage(client, JSON.stringify({ op: "join-chan", token: `${TOKEN}${i}` }));
    }
    const limited = client.sent.filter((m) => m.op === "error" && m.code === "rate-limited");
    expect(limited.length).toBeGreaterThan(0);
  });

  test("a full channel rejects a third member", () => {
    const core = new RelayCore();
    const a = fakeClient(1);
    const b = fakeClient(2, "2.2.2.2");
    const c = fakeClient(3, "3.3.3.3");
    for (const cl of [a, b, c]) {
      core.handleMessage(cl, JSON.stringify({ op: "join-chan", token: TOKEN }));
    }
    expect(c.sent.some((m) => m.op === "error" && m.code === "chan-full")).toBe(true);
  });
});
