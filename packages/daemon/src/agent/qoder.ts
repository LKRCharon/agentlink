/**
 * Qoder 适配器：`qodercli --acp`（ACP，JSON-RPC over stdio）。
 *
 * 映射关系：
 * - session/update.agent_message_chunk → text
 * - session/update.tool_call(_update) → tool-call / tool-result
 * - session/request_permission（server→client 请求，挂起等桥接层）→ permission-request
 * - session/prompt 的响应 stopReason → turn-done
 */

import { StdioJsonRpc } from "./jsonrpc";
import { EventQueue, type AgentAdapter, type AgentSession, type NormalizedEvent } from "./types";

interface AcpToolCall {
  toolCallId?: string;
  title?: string;
  status?: string;
  kind?: string;
  rawInput?: unknown;
}

function summarize(input: unknown, max = 200): string {
  let s: string;
  try {
    s = typeof input === "string" ? input : JSON.stringify(input);
  } catch {
    s = String(input);
  }
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export class QoderAdapter implements AgentAdapter {
  readonly name = "qoder";

  /**
   * @param cmd 启动命令（测试时可注入 fake agent）
   */
  constructor(private readonly cmd: string[] = [process.env.QODERCLI_BIN ?? "qodercli", "--acp"]) {}

  async start(opts: { cwd: string; prompt?: string; model?: string }): Promise<AgentSession> {
    const rpc = new StdioJsonRpc(this.cmd, { cwd: opts.cwd });
    const events = new EventQueue<NormalizedEvent>();
    const permissionResolvers = new Map<string, (result: unknown) => void>();

    rpc.onNotification = (method, params) => {
      if (method !== "session/update") return;
      const u = (params as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string }; toolCallId?: string; title?: string; status?: string; rawInput?: unknown } })
        ?.update;
      if (!u?.sessionUpdate) return;
      switch (u.sessionUpdate) {
        case "agent_message_chunk":
          if (u.content?.type === "text" && u.content.text) {
            events.push({ type: "text", text: u.content.text });
          }
          break;
        case "tool_call":
          events.push({
            type: "tool-call",
            name: u.title ?? u.toolCallId ?? "tool",
            summary: summarize(u.rawInput),
          });
          break;
        case "tool_call_update":
          if (u.status === "completed" || u.status === "failed") {
            events.push({ type: "tool-result", name: u.title ?? u.toolCallId ?? "tool", summary: u.status });
          }
          break;
      }
    };

    rpc.onServerRequest = (method, id, params) => {
      if (method !== "session/request_permission") return Promise.resolve({});
      const p = params as { options?: { optionId?: string; name?: string }[]; toolCall?: AcpToolCall };
      const options = (p?.options ?? []).map((o, i) => ({
        id: o.optionId ?? `opt-${i}`,
        label: o.name ?? o.optionId ?? `选项 ${i + 1}`,
      }));
      const requestId = String(id);
      events.push({
        type: "permission-request",
        requestId,
        toolName: p?.toolCall?.title ?? "unknown",
        summary: summarize(p?.toolCall?.rawInput ?? p?.toolCall),
        options,
        respond: async (optionId) => {
          const resolve = permissionResolvers.get(requestId);
          permissionResolvers.delete(requestId);
          if (optionId === "__deny__") {
            resolve?.({ outcome: { outcome: "cancelled" } });
          } else {
            resolve?.({ outcome: { outcome: "selected", optionId } });
          }
        },
      });
      // 挂起，直到桥接层把远端审批结果传回来
      return new Promise((resolve) => {
        permissionResolvers.set(requestId, resolve);
      });
    };

    rpc.onExit = (code) => {
      events.push({ type: "error", message: `qoder 进程退出（code ${code}）` });
      events.close();
    };

    const initResult = await rpc.request<{ authMethods?: { id: string }[] }>("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: "agentlink", version: "0.1.0" },
    });
    // ACP 要求先认证（qodercli-login 复用已有登录态）
    if (initResult.authMethods && initResult.authMethods.length > 0) {
      await rpc.request("authenticate", { method: initResult.authMethods[0].id });
    }
    const res = await rpc.request<{ sessionId: string }>("session/new", { cwd: opts.cwd, mcpServers: [] });
    const sessionId = res.sessionId;

    const send = async (text: string): Promise<void> => {
      try {
        const r = await rpc.request<{ stopReason?: string }>("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text }],
        });
        events.push({ type: "turn-done", reason: r?.stopReason ?? "stop" });
      } catch (e) {
        events.push({ type: "error", message: e instanceof Error ? e.message : String(e) });
      }
    };

    if (opts.prompt) void send(opts.prompt);

    return {
      id: sessionId,
      send,
      events,
      stop: async () => {
        events.close();
        await rpc.stop();
      },
    };
  }
}
