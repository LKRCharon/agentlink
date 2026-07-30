/**
 * Codex 适配器：`codex app-server`（JSON-RPC over stdio，v2 协议）。
 *
 * 认证兼容（重点）：不强依赖 ChatGPT 登录——适配层只透传环境与 cwd 配置，
 * 以下任一方式均可工作：
 *   1. ChatGPT 账号（codex login）
 *   2. API 模式 A：OPENAI_API_KEY / CODEX_API_KEY 环境变量
 *   3. API 模式 B：~/.codex/config.toml 配置 preferred_auth_method = "apikey"
 *   4. 自定义 provider（如 your-gateway 等 OpenAI 兼容网关）：config.toml 的
 *      [model_providers.xxx] base_url + env_key，配合 AGENTLINK_CODEX_PROVIDER 指定
 * 启动前用 `codex login status` 做预检，未登录时报错并给出上述 API 模式指引。
 *
 * 映射关系：
 * - item/agentMessage/delta → text
 * - item/started(commandExecution 等) → tool-call；item/completed → tool-result
 * - item/commandExecution/requestApproval、execCommandApproval、
 *   item/fileChange/requestApproval、applyPatchApproval → permission-request
 * - turn/completed → turn-done
 */

import { spawnSync } from "node:child_process";
import { StdioJsonRpc } from "./jsonrpc";
import { EventQueue, type AgentAdapter, type AgentSession, type NormalizedEvent, type PermissionOption } from "./types";

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

const APPROVAL_OPTIONS: PermissionOption[] = [
  { id: "accept", label: "允许" },
  { id: "acceptForSession", label: "本会话始终允许" },
  { id: "decline", label: "拒绝" },
];

const AUTH_GUIDANCE = `codex 未登录。可选认证方式（API 模式不依赖 ChatGPT）：
  1. API Key:  export OPENAI_API_KEY=...（或 CODEX_API_KEY）
  2. 配置文件:  ~/.codex/config.toml 设置 preferred_auth_method = "apikey"
  3. 自定义 provider（OpenAI 兼容网关，如 your-gateway）:
       [model_providers.my]
       name = "my"
       base_url = "https://your-gateway.example.com/v1"
       env_key = "OPENAI_API_KEY"
     然后 AGENTLINK_CODEX_PROVIDER=my 再启动
  4. ChatGPT 账号:  codex login（国内网络环境通常不可用）`;

export class CodexAdapter implements AgentAdapter {
  readonly name = "codex";

  constructor(
    private readonly bin: string = process.env.CODEX_BIN ?? "codex",
    private readonly cmdOverride?: string[],
  ) {}

  /** 登录预检：已通过 / 未通过（含 API 模式指引） */
  checkAuth(): { ok: boolean; status: string } {
    try {
      const r = spawnSync(this.bin, ["login", "status"], { encoding: "utf8", timeout: 15_000 });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
      return { ok: r.status === 0 && /logged in/i.test(out), status: out };
    } catch (e) {
      return { ok: false, status: `无法执行 codex login status: ${e instanceof Error ? e.message : e}` };
    }
  }

  async start(opts: { cwd: string; prompt?: string; model?: string }): Promise<AgentSession> {
    if (!this.cmdOverride) {
      const auth = this.checkAuth();
      if (!auth.ok) {
        throw new Error(`${AUTH_GUIDANCE}\n\n当前状态: ${auth.status || "未知"}`);
      }
    }

    const cmd = this.cmdOverride ?? [this.bin, "app-server"];
    const rpc = new StdioJsonRpc(cmd, { cwd: opts.cwd });
    const events = new EventQueue<NormalizedEvent>();
    const permissionResolvers = new Map<string, (result: unknown) => void>();

    rpc.onNotification = (method, params) => {
      const p = params as Record<string, unknown> | undefined;
      switch (method) {
        case "item/agentMessage/delta": {
          const delta = (p?.delta ?? p?.text ?? "") as string;
          if (delta) events.push({ type: "text", text: delta });
          break;
        }
        case "item/started": {
          const item = p?.item as { type?: string; command?: string; name?: string } | undefined;
          if (item && item.type !== "agentMessage") {
            events.push({
              type: "tool-call",
              name: item.type ?? "item",
              summary: summarize(item.command ?? item.name ?? item),
            });
          }
          break;
        }
        case "item/completed": {
          const item = p?.item as { type?: string } | undefined;
          if (item && item.type !== "agentMessage") {
            events.push({ type: "tool-result", name: item.type ?? "item", summary: "completed" });
          }
          break;
        }
        case "turn/completed": {
          const turn = p?.turn as { status?: string } | undefined;
          events.push({ type: "turn-done", reason: turn?.status ?? "completed" });
          break;
        }
      }
    };

    rpc.onServerRequest = (method, id, params) => {
      const approvalMethods: Record<string, string> = {
        "item/commandExecution/requestApproval": "命令执行",
        execCommandApproval: "命令执行",
        "item/fileChange/requestApproval": "文件修改",
        applyPatchApproval: "文件修改",
        "item/permissions/requestApproval": "权限申请",
      };
      const toolName = approvalMethods[method];
      if (!toolName) return Promise.resolve({});
      const p = params as { command?: string[] | string; reason?: string } | undefined;
      const requestId = String(id);
      events.push({
        type: "permission-request",
        requestId,
        toolName,
        summary: summarize(p?.command ?? p?.reason ?? p),
        options: APPROVAL_OPTIONS,
        respond: async (optionId) => {
          const resolve = permissionResolvers.get(requestId);
          permissionResolvers.delete(requestId);
          const decision = optionId === "__deny__" ? "decline" : optionId;
          resolve?.({ decision });
        },
      });
      return new Promise((resolve) => {
        permissionResolvers.set(requestId, resolve);
      });
    };

    rpc.onExit = (code) => {
      events.push({ type: "error", message: `codex 进程退出（code ${code}）` });
      events.close();
    };

    await rpc.request("initialize", {
      clientInfo: { name: "agentlink", version: "0.1.0" },
    });
    rpc.notify("initialized");

    const threadParams: Record<string, unknown> = {
      cwd: opts.cwd,
      approvalPolicy: process.env.AGENTLINK_CODEX_APPROVAL_POLICY ?? "on-request",
      sandbox: process.env.AGENTLINK_CODEX_SANDBOX ?? "workspace-write",
    };
    const model = opts.model ?? process.env.AGENTLINK_CODEX_MODEL;
    if (model) threadParams.model = model;
    if (process.env.AGENTLINK_CODEX_PROVIDER) threadParams.modelProvider = process.env.AGENTLINK_CODEX_PROVIDER;

    const thread = await rpc.request<{ thread: { id: string } }>("thread/start", threadParams);
    const threadId = thread.thread.id;

    const send = async (text: string): Promise<void> => {
      try {
        await rpc.request("turn/start", {
          threadId,
          input: [{ type: "text", text, text_elements: [] }],
        });
      } catch (e) {
        events.push({ type: "error", message: e instanceof Error ? e.message : String(e) });
      }
    };

    if (opts.prompt) void send(opts.prompt);

    return {
      id: threadId,
      send,
      events,
      stop: async () => {
        events.close();
        await rpc.stop();
      },
    };
  }
}
