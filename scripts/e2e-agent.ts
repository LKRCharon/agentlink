/**
 * M1.2 全链路验证：配对 → daemon 桥接 fake Qoder agent → 手机端看事件流、
 * 远程批准权限 → agent 完成本轮。
 *
 * 运行: bun run scripts/e2e-agent.ts
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { createRelayServer } = await import("../packages/relay/src/server");
const { runPair, runProbe } = await import("../packages/daemon/src/client");
const { QoderAdapter } = await import("../packages/daemon/src/agent/qoder");
const { CodexAdapter } = await import("../packages/daemon/src/agent/codex");
const { serveAgent } = await import("../packages/daemon/src/agent/serve");

import type { AgentAdapter } from "../packages/daemon/src/agent/types";

const here = dirname(fileURLToPath(import.meta.url));
const fakeQoder = join(here, "../packages/daemon/test/fixtures/fake-qoder-acp.ts");
const fakeCodex = join(here, "../packages/daemon/test/fixtures/fake-codex-appserver.ts");

let failed = 0;
function report(name: string, pass: boolean): void {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (!pass) failed++;
}

async function runCase(name: string, makeAdapter: () => AgentAdapter): Promise<void> {
  console.log(`\n--- ${name} ---`);
  // 每个用例独立身份目录 + 独立 relay，避免上个用例的在线连接占用设备通道
  process.env.AGENTLINK_HOME = mkdtempSync(join(tmpdir(), "agentlink-e2e-agent-"));
  const server = createRelayServer(0);
  process.env.AGENTLINK_RELAY = `ws://127.0.0.1:${server.port}/ws`;

  let resolveCode!: (c: string) => void;
  const codePromise = new Promise<string>((r) => (resolveCode = r));
  const pairError = runPair({
    onCode: resolveCode,
    onServe: (conn, chan) => serveAgent(conn, chan, makeAdapter(), { cwd: process.cwd(), prompt: "hello" }),
  }).catch((e: Error) => e);

  const code = await codePromise;
  const probe = await runProbe(code, { agentDemo: true });
  report(`${name}：事件流 + 远程审批全链路`, probe.agentDone === true);

  const err = await Promise.race([pairError, Promise.resolve(null)]);
  report(`${name}：daemon 侧无异常`, err === null || err === undefined);
  server.stop();
}

async function main(): Promise<void> {
  await runCase("qoder(ACP)", () => new QoderAdapter(["bun", "run", fakeQoder]));
  await runCase("codex(app-server)", () => new CodexAdapter("codex", ["bun", "run", fakeCodex]));

  console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("e2e-agent 执行异常:", e);
  process.exit(1);
});
