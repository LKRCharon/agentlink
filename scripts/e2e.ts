/**
 * M1.1 全链路验证（进程内完成，无需手工操作）：
 *   1. 配对 + E2E 加密 echo 打通
 *   2. 错误配对码（中间人场景）被双方拒绝
 *   3. relay health 端点
 *
 * 运行: bun run e2e
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 隔离配置目录（必须在 import daemon 之前设置）
process.env.AGENTLINK_HOME = mkdtempSync(join(tmpdir(), "agentlink-e2e-"));

const { createRelayServer } = await import("../packages/relay/src/server");
const server = createRelayServer(0);
process.env.AGENTLINK_RELAY = `ws://127.0.0.1:${server.port}/ws`;

const { runPair, runProbe } = await import("../packages/daemon/src/client");

let failed = 0;
function report(name: string, pass: boolean, detail = ""): void {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!pass) failed++;
}

async function main(): Promise<void> {
  console.log(`relay: ${process.env.AGENTLINK_RELAY}\n`);

  // ---- 用例 1：正常配对 + echo ----
  let resolveCode!: (c: string) => void;
  const codePromise = new Promise<string>((r) => (resolveCode = r));
  const pairPromise = runPair({ onCode: resolveCode }); // serve 循环在后台挂着，进程退出时收尾
  const pairError = pairPromise.catch((e: Error) => e);

  const code = await codePromise;
  const probe = await runProbe(code, { echoText: "e2e-hello" });
  report("配对 + E2E 加密 echo 打通", probe.rtt >= 0, `RTT ${probe.rtt}ms`);

  // ---- 用例 2：错误配对码（中间人）被双方拒绝 ----
  let resolveCode2!: (c: string) => void;
  const codePromise2 = new Promise<string>((r) => (resolveCode2 = r));
  const pairPromise2 = runPair({ onCode: resolveCode2, serve: false });
  const code2 = await codePromise2;
  const wrongCode = `${code2.slice(0, 5)}AAAAAA`;

  // pair 与 probe 必须并发，否则双方互等死锁
  const probePromise2 = runProbe(wrongCode);
  const [pairResult2, probeResult2] = await Promise.all([
    pairPromise2.then(
      () => ({ ok: true as const }),
      (e: Error) => ({ ok: false as const, error: e }),
    ),
    probePromise2.then(
      () => ({ ok: true as const }),
      (e: Error) => ({ ok: false as const, error: e }),
    ),
  ]);
  report(
    "错误配对码被发起方拒绝",
    !pairResult2.ok && /密钥确认失败/.test(pairResult2.ok ? "" : pairResult2.error.message),
  );
  report(
    "错误配对码被加入方拒绝",
    !probeResult2.ok && /密钥确认失败/.test(probeResult2.ok ? "" : probeResult2.error.message),
  );

  // ---- 用例 3：health ----
  const res = await fetch(`http://127.0.0.1:${server.port}/health`);
  const body = (await res.json()) as { ok?: boolean };
  report("relay /health", res.status === 200 && body.ok === true);

  // 用例 1 的 pair 端不应异常退出
  const pairErr = await Promise.race([pairError, Promise.resolve(null)]);
  report("配对发起方无异常", pairErr === null || pairErr === undefined);

  console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
  server.stop();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("e2e 执行异常:", e);
  server.stop();
  process.exit(1);
});
