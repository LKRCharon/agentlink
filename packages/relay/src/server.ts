/**
 * Bun.serve 接线层：WebSocket 升级 / 消息大小闸门 / 定期清理。
 * 日志只留 op 级别信息，绝不记录消息体（密文也不落盘）。
 */

import { RelayCore, type Client } from "./relay";

export function createRelayServer(port = 8787) {
  const core = new RelayCore();
  let nextId = 1;

  const server = Bun.serve<Client>({
    port,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({ ok: true, uptime: Math.round(process.uptime()) });
      }
      if (url.pathname === "/ws") {
        const client: Client = {
          id: nextId++,
          ip: srv.requestIP(req)?.address ?? "unknown",
          send: () => {},
        };
        return srv.upgrade(req, { data: client }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      idleTimeout: 120, // 2 分钟无 pong 响应则关闭（幽灵连接 eviction）
      sendPings: true,
      open(ws) {
        const client = ws.data;
        client.send = (data) => {
          try {
            ws.send(data);
          } catch {
            // 连接已关闭，忽略
          }
        };
      },
      message(ws, message) {
        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        if (text.length > 300_000) {
          ws.send(JSON.stringify({ op: "error", code: "too-large", message: "消息过大" }));
          return;
        }
        core.handleMessage(ws.data, text);
      },
      close(ws) {
        core.handleClose(ws.data);
      },
    },
  });

  const timer = setInterval(() => core.sweep(), 60_000);
  timer.unref();

  return server;
}
