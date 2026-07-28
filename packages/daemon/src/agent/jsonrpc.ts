/**
 * 通用 stdio JSON-RPC 2.0 客户端（JSONL 帧，一行一条消息）。
 * 同时服务 ACP（Qoder）与 codex app-server 两类子进程：
 * - client → server：request / notify
 * - server → client：notification（onNotification）与 request（onServerRequest，挂起等待业务层回答）
 */

import { spawn, type FileSink, type Subprocess } from "bun";

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class StdioJsonRpc {
  private proc: Subprocess;
  private stdin: FileSink;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = "";

  onNotification?: (method: string, params: unknown) => void;
  onServerRequest?: (method: string, id: number | string, params: unknown) => Promise<unknown>;
  onExit?: (code: number) => void;

  constructor(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
    this.proc = spawn(cmd, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.stdin = this.proc.stdin as FileSink;
    void this.readLoop();
    void this.watchExit();
  }

  private async readLoop(): Promise<void> {
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      this.buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) this.handleLine(line);
      }
    }
  }

  private async watchExit(): Promise<void> {
    const code = await this.proc.exited;
    for (const p of this.pending.values()) p.reject(new Error(`agent 进程已退出（code ${code}）`));
    this.pending.clear();
    this.onExit?.(code);
  }

  private handleLine(line: string): void {
    let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 非 JSON 行（如 agent 的日志混入），忽略
    }
    // 响应：有 id 且无 method
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(Number(msg.id));
      if (p) {
        this.pending.delete(Number(msg.id));
        if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
      return;
    }
    // server → client 请求：有 method 且有 id
    if (msg.method && msg.id !== undefined) {
      void (async () => {
        try {
          const result = this.onServerRequest
            ? await this.onServerRequest(msg.method!, msg.id!, msg.params)
            : {};
          this.sendRaw({ jsonrpc: "2.0", id: msg.id, result: result ?? {} });
        } catch (e) {
          this.sendRaw({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32000, message: e instanceof Error ? e.message : String(e) },
          });
        }
      })();
      return;
    }
    // 通知
    if (msg.method) this.onNotification?.(msg.method, msg.params);
  }

  private sendRaw(obj: unknown): void {
    try {
      this.stdin.write(`${JSON.stringify(obj)}\n`);
      this.stdin.flush();
    } catch {
      // 进程已退出
    }
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.sendRaw({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.sendRaw({ jsonrpc: "2.0", method, params });
  }

  async stop(): Promise<void> {
    try {
      this.stdin.end();
    } catch {
      // 忽略
    }
    this.proc.kill();
  }
}
