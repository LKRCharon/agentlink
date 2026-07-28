/**
 * Agent 适配层公共类型。
 * 每个 adapter 把自家协议（ACP / app-server / 其他）归一化为 NormalizedEvent 流，
 * 桥接层（serve.ts）只面向这里的类型工作。
 */

export interface PermissionOption {
  id: string;
  label: string;
}

export interface NormalizedPermissionRequest {
  type: "permission-request";
  requestId: string;
  toolName: string;
  summary: string;
  options: PermissionOption[];
  /** 桥接层回答审批；optionId 为 "__deny__" 时表示超时/拒绝兜底 */
  respond: (optionId: string) => Promise<void>;
}

export type NormalizedEvent =
  | { type: "text"; text: string }
  | { type: "user-text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool-call"; name: string; summary: string }
  | { type: "tool-result"; name: string; summary: string }
  | { type: "turn-done"; reason: string }
  | { type: "error"; message: string }
  | NormalizedPermissionRequest;

export interface AgentSession {
  id: string;
  send(text: string): Promise<void>;
  events: AsyncIterable<NormalizedEvent>;
  stop(): Promise<void>;
}

export interface AgentAdapter {
  readonly name: string;
  start(opts: { cwd: string; prompt?: string; model?: string }): Promise<AgentSession>;
}

/** 有界缓冲的异步事件队列（adapter 生产 → 桥接层消费） */
export class EventQueue<T> {
  private buf: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(v: T): void {
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.buf.push(v);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length) {
      this.waiters.shift()!({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buf.length) return Promise.resolve({ value: this.buf.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
