/**
 * agentlink daemon CLI
 *
 *   agentlink init                生成/查看设备身份
 *   agentlink pair                生成配对码，等待手机端配对（配对后进入在线服务）
 *   agentlink probe <配对码>       模拟手机端加入并发送 echo 验证链路
 *   agentlink up                  常驻在线，等待已配对设备连接
 *   agentlink peers               列出已配对设备
  agentlink rename <指纹> <名称>  重命名已配对设备
  agentlink forget <指纹>        移除已配对设备
 *
 * 环境变量：
 *   AGENTLINK_RELAY   relay 地址（默认 ws://127.0.0.1:8787/ws）
 *   AGENTLINK_HOME    配置目录（默认 ~/.agentlink）
 */

import { fingerprint } from "@agentlink/wire";
import { listPeers, loadOrCreateIdentity, renamePeer, removePeer } from "./store";
import { runAgent, runPair, runProbe, runUp } from "./client";
import { runWatch } from "./watcher/serve";

const [cmd, ...args] = process.argv.slice(2);

function usage(): void {
  console.log(`agentlink daemon

用法:
  agentlink init                生成/查看设备身份
  agentlink pair                生成配对码，等待手机端配对
  agentlink probe <NNNN-XXXXXX> 模拟手机端加入并发送 echo
  agentlink up                  常驻在线，等待已配对设备连接
  agentlink peers               列出已配对设备
  agentlink rename <指纹> <名称>  重命名已配对设备
  agentlink forget <指纹>        移除已配对设备

环境变量: AGENTLINK_RELAY, AGENTLINK_HOME`);
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  switch (cmd) {
    case "init": {
      const id = loadOrCreateIdentity();
      console.log(`设备身份已就绪，指纹: ${fingerprint(id.publicKey)}`);
      break;
    }
    case "pair": {
      await runPair({ json: args.includes("--json"), serve: !args.includes("--no-serve") });
      break;
    }
    case "probe": {
      const code = args[0];
      if (!code) {
        console.error("用法: agentlink probe <NNNN-XXXXXX>");
        process.exit(1);
      }
      await runProbe(code);
      break;
    }
    case "up": {
      await runUp();
      break;
    }
    case "agent": {
      const name = args[0];
      if (name !== "qoder" && name !== "codex") {
        console.error("用法: agentlink agent <qoder|codex> [--prompt 文本] [--cwd 目录]");
        process.exit(1);
      }
      const prompt = flagValue(args, "--prompt");
      const cwd = flagValue(args, "--cwd") ?? process.cwd();
      const model = flagValue(args, "--model");
      await runAgent(name, { cwd, prompt, model });
      break;
    }
    case "watch": {
      const hookPort = flagValue(args, "--hook-port");
      await runWatch(hookPort ? { hookPort: Number(hookPort) } : {});
      break;
    }
    case "rename": {
      const positional = args.filter((a) => !a.startsWith("--"));
      const [fp, ...nameParts] = positional;
      const name = nameParts.join(" ");
      if (!fp || !name) {
        console.error("用法: agentlink rename <指纹> <新名称>");
        process.exit(1);
      }
      const ok = renamePeer(fp, name);
      if (args.includes("--json") || process.env.AGENTLINK_JSON) {
        process.stdout.write(JSON.stringify({ type: ok ? "renamed" : "error", fingerprint: fp, deviceName: name }) + "\n");
      } else {
        console.log(ok ? `已重命名为 ${name}` : `未找到设备 ${fp}`);
      }
      if (!ok) process.exit(1);
      break;
    }
    case "forget": {
      const fp = args.filter((a) => !a.startsWith("--"))[0];
      if (!fp) {
        console.error("用法: agentlink forget <指纹>");
        process.exit(1);
      }
      const ok = removePeer(fp);
      if (args.includes("--json") || process.env.AGENTLINK_JSON) {
        process.stdout.write(JSON.stringify({ type: ok ? "forgotten" : "error", fingerprint: fp }) + "\n");
      } else {
        console.log(ok ? `已移除设备 ${fp}` : `未找到设备 ${fp}`);
      }
      if (!ok) process.exit(1);
      break;
    }
    case "peers": {
      const peers = Object.values(listPeers());
      if (args.includes("--json")) {
        process.stdout.write(JSON.stringify({ type: "peers", peers }) + "\n");
        break;
      }
      if (peers.length === 0) {
        console.log("尚未配对任何设备");
      } else {
        for (const p of peers) {
          console.log(`${p.deviceName} (${p.platform})  [${p.fingerprint}]  配对于 ${new Date(p.pairedAt).toLocaleString()}`);
        }
      }
      break;
    }
    default:
      usage();
      if (cmd) process.exit(1);
  }
}

main().catch((e) => {
  console.error(`错误: ${e?.message ?? e}`);
  process.exit(1);
});
