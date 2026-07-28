import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { QoderAdapter } from "../src/agent/qoder";
import { CodexAdapter } from "../src/agent/codex";
import type { AgentSession, NormalizedEvent, NormalizedPermissionRequest } from "../src/agent/types";

const here = dirname(fileURLToPath(import.meta.url));
const fakeQoder = join(here, "fixtures", "fake-qoder-acp.ts");
const fakeCodex = join(here, "fixtures", "fake-codex-appserver.ts");

async function collectUntilDone(
  session: AgentSession,
  onEvent: (ev: NormalizedEvent) => void,
): Promise<NormalizedEvent[]> {
  const out: NormalizedEvent[] = [];
  for await (const ev of session.events) {
    out.push(ev);
    onEvent(ev);
    if (ev.type === "turn-done") break;
  }
  return out;
}

describe("agent adapters", () => {
  test("QoderAdapter（ACP）：事件归一化 + 权限往返", async () => {
    const adapter = new QoderAdapter(["bun", "run", fakeQoder]);
    const session = await adapter.start({ cwd: process.cwd(), prompt: "hello" });
    const events = await collectUntilDone(session, (ev) => {
      if (ev.type === "permission-request") void ev.respond("allow");
    });
    await session.stop();

    const types = events.map((e) => e.type);
    expect(types).toContain("text");
    expect(types).toContain("tool-call");
    expect(types).toContain("permission-request");
    expect(types).toContain("tool-result");
    expect(types[types.length - 1]).toBe("turn-done");

    const perm = events.find((e) => e.type === "permission-request") as NormalizedPermissionRequest | undefined;
    expect(perm?.toolName).toBe("写文件");
    expect(perm?.options[0]).toEqual({ id: "allow", label: "允许" });
  }, 20_000);

  test("CodexAdapter（app-server）：事件归一化 + 审批决策", async () => {
    const adapter = new CodexAdapter("codex", ["bun", "run", fakeCodex]);
    const session = await adapter.start({ cwd: process.cwd(), prompt: "hello" });
    const events = await collectUntilDone(session, (ev) => {
      if (ev.type === "permission-request") void ev.respond("accept");
    });
    await session.stop();

    const types = events.map((e) => e.type);
    expect(types).toContain("text");
    expect(types).toContain("tool-call");
    expect(types).toContain("permission-request");
    expect(types).toContain("tool-result");
    expect(types[types.length - 1]).toBe("turn-done");

    const perm = events.find((e) => e.type === "permission-request") as NormalizedPermissionRequest | undefined;
    expect(perm?.toolName).toBe("命令执行");
    expect(perm?.options.map((o) => o.id)).toEqual(["accept", "acceptForSession", "decline"]);
  }, 20_000);
});
