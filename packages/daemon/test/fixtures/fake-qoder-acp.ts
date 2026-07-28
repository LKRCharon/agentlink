/**
 * 测试用 fake ACP agent（模拟 qodercli --acp 的协议行为）：
 * initialize → session/new → prompt 时输出文本/工具调用，
 * 发起一次权限请求，被批准后立即完成本轮。
 */

const decoder = new TextDecoder();
let buffer = "";
let pendingPromptId: number | string | null = null;

function send(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function update(u: Record<string, unknown>): void {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fake-qoder-1", update: u } });
}

function handle(msg: { id?: number | string; method?: string }): void {
  // server request（权限）的响应
  if (msg.id !== undefined && msg.method === undefined) {
    if (pendingPromptId !== null) {
      const id = pendingPromptId;
      pendingPromptId = null;
      update({ sessionUpdate: "tool_call_update", toolCallId: "tc-1", title: "写文件", status: "completed" });
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    }
    return;
  }
  switch (msg.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
      break;
    case "session/new":
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "fake-qoder-1" } });
      break;
    case "session/prompt": {
      pendingPromptId = msg.id ?? null;
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fake qoder 输出\n" } });
      update({ sessionUpdate: "tool_call", toolCallId: "tc-1", title: "写文件", rawInput: { path: "/tmp/demo.txt" } });
      send({
        jsonrpc: "2.0",
        id: 999,
        method: "session/request_permission",
        params: {
          sessionId: "fake-qoder-1",
          toolCall: { toolCallId: "tc-1", title: "写文件", rawInput: { path: "/tmp/demo.txt" } },
          options: [
            { optionId: "allow", name: "允许" },
            { optionId: "deny", name: "拒绝" },
          ],
        },
      });
      break;
    }
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  buffer += decoder.decode(chunk, { stream: true });
  let idx: number;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) handle(JSON.parse(line));
  }
});
export {};
