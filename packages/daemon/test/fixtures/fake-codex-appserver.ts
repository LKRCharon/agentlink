/**
 * 测试用 fake codex app-server：
 * initialize → thread/start → turn/start 时输出 delta/工具项，
 * 发起一次命令执行审批，被批准后完成本轮。
 */

const decoder = new TextDecoder();
let buffer = "";
let pendingTurnId: number | string | null = null;

function send(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function handle(msg: { id?: number | string; method?: string }): void {
  // 审批响应
  if (msg.id !== undefined && msg.method === undefined) {
    if (pendingTurnId !== null) {
      const id = pendingTurnId;
      pendingTurnId = null;
      send({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "fake-thread-1", turnId: "turn-1", item: { type: "commandExecution" } } });
      send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "fake-thread-1", turn: { id: "turn-1", status: "completed" } } });
      send({ jsonrpc: "2.0", id, result: { turn: { id: "turn-1", status: "completed" } } });
    }
    return;
  }
  switch (msg.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
      break;
    case "initialized":
      break;
    case "thread/start":
      send({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "fake-thread-1" }, model: "fake-model", modelProvider: "fake" } });
      break;
    case "turn/start": {
      pendingTurnId = msg.id ?? null;
      send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "fake-thread-1", itemId: "m-1", delta: "fake codex 输出\n" } });
      send({ jsonrpc: "2.0", method: "item/started", params: { threadId: "fake-thread-1", turnId: "turn-1", item: { type: "commandExecution", command: "ls -la" } } });
      send({
        jsonrpc: "2.0",
        id: 888,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "fake-thread-1", turnId: "turn-1", itemId: "item-1", command: ["ls", "-la"], reason: "列出目录" },
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
