/**
 * Hook HTTP server：接收 Qoder 的 PermissionRequest 等 hook 事件。
 * 共享密钥鉴权（X-Agentlink-Secret header），防止本机其他进程伪造请求。
 */

import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HookPermissionRequest {
  sessionId: string;
  requestId: string;
  toolName: string;
  summary: string;
  options: { id: string; label: string }[];
  /** 桥接层调用：把手机端的审批结果回传 */
  resolve: (decision: string) => void;
}

export class HookServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private pendingPermissions = new Map<string, HookPermissionRequest>();

  constructor(
    private onPermissionRequest: (req: HookPermissionRequest) => void,
    private port = 9876,
    /**
     * Argus posts the outcome of a keystroke injection here. Without it the
     * phone was told "delivered" before anything was typed, so Qoder not running
     * or missing Accessibility permission looked like success.
     */
    private onInjectionResult?: (sessionId: string, ok: boolean, note: string) => void,
  ) {}

  /** 生成或加载共享密钥，打印 Qoder settings.json 配置片段 */
  static getOrCreateSecret(): string {
    const file = join(process.env.AGENTLINK_HOME ?? join(homedir(), ".agentlink"), "hook-secret");
    if (existsSync(file)) {
      return readFileSync(file, "utf8").trim();
    }
    const secret = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(24))).toString("hex");
    writeFileSync(file, secret, { mode: 0o600 });
    chmodSync(file, 0o600);
    return secret;
  }

  start(secret: string): void {
    this.server = Bun.serve({
      port: this.port,
      hostname: "127.0.0.1", // 只绑 localhost，不暴露到网络
      fetch: (req) => this.handleRequest(req, secret),
    });
    console.log(`[hook-server] listening on http://127.0.0.1:${this.port}`);
  }

  stop(): void {
    this.server?.stop();
    this.server = null;
  }

  /** Whether this id belongs to a hook request still waiting for an answer. */
  hasPending(requestId: string): boolean {
    return this.pendingPermissions.has(requestId);
  }

  /** 桥接层调用：手机端审批结果到达后，解除挂起的 hook 请求 */
  resolvePermission(requestId: string, decision: string): void {
    const pending = this.pendingPermissions.get(requestId);
    if (pending) {
      this.pendingPermissions.delete(requestId);
      pending.resolve(decision);
    }
  }

  private async handleRequest(req: Request, secret: string): Promise<Response> {
    // 鉴权
    const authHeader = req.headers.get("X-Agentlink-Secret");
    if (authHeader !== secret) {
      return new Response("unauthorized", { status: 401 });
    }

    const path = new URL(req.url).pathname;
    if (req.method === "POST" && path === "/inject-result") {
      try {
        const body: any = await req.json();
        this.onInjectionResult?.(
          String(body?.sessionId ?? ""),
          body?.ok === true,
          String(body?.note ?? ""),
        );
      } catch {
        return new Response("bad json", { status: 400 });
      }
      return Response.json({ ok: true });
    }

    if (req.method !== "POST" || path !== "/hook") {
      return new Response("not found", { status: 404 });
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }

    // PermissionRequest hook → 转发到手机，挂起等待响应
    if (body?.hookEvent === "PermissionRequest" || body?.type === "PermissionRequest") {
      const requestId = `hook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const toolName = body.toolCall?.title ?? body.toolName ?? body.tool ?? "unknown";
      const summary = JSON.stringify(body.toolCall?.rawInput ?? body.input ?? body).slice(0, 200);

      const decision = await new Promise<string>((resolve) => {
        const hookReq: HookPermissionRequest = {
          sessionId: body.sessionId ?? "qoder-ide",
          requestId,
          toolName,
          summary,
          options: [
            { id: "allow", label: "允许" },
            { id: "deny", label: "拒绝" },
          ],
          resolve,
        };
        this.pendingPermissions.set(requestId, hookReq);
        this.onPermissionRequest(hookReq);

        // 10 分钟超时自动拒绝
        setTimeout(() => {
          if (this.pendingPermissions.delete(requestId)) {
            resolve("deny");
          }
        }, 10 * 60_000);
      });

      // Qoder's PermissionRequest hook reads hookSpecificOutput
      // .permissionDecision ("allow" | "deny" | "ask") — the old
      // { decision: "accept" } shape was silently ignored, so a phone approval
      // never reached the IDE (verified against the qodercli binary schema).
      return Response.json({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          permissionDecision: decision === "allow" ? "allow" : "deny",
          permissionDecisionReason: decision === "allow"
            ? "已在手机上批准 (Argus)"
            : "已在手机上拒绝或超时 (Argus)",
        },
      });
    }

    // 其他 hook 事件（PreToolUse/PostToolUse/Stop 等）：不干预，交回本机决策
    return Response.json({});
  }
}
