import { useEffect, useRef, useState } from "react";
import { useStore, type SessionEvent, type SessionPermission } from "../store";

export default function SessionDetailView() {
  const { sessions, activeSessionId, setActiveSession, respondPermission, sendInput } = useStore();
  const session = activeSessionId ? sessions[activeSessionId] : null;
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // 自动滚动到底部
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [session?.events.length, session?.permissions.length]);

  if (!session) {
    useStore.getState().setActiveSession(null);
    return null;
  }

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    void sendInput(session.sessionId, input.trim());
    setInput("");
  };

  return (
    <div className="mx-auto flex h-full max-w-md flex-col bg-slate-950">
      {/* 顶栏 */}
      <header className="flex items-center gap-3 border-b border-slate-800 px-4 py-3">
        <button onClick={() => setActiveSession(null)} className="text-slate-400 hover:text-slate-200">
          ← 返回
        </button>
        <div className="flex-1">
          <span className="font-mono text-sm text-slate-200">{session.agent}</span>
        </div>
        <StatusBadge status={session.status} />
      </header>

      {/* 事件流 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin px-4 py-3">
        <div className="space-y-1">
          {session.events.map((ev, i) => (
            <EventRow key={i} event={ev} />
          ))}
          {session.events.length === 0 && (
            <p className="py-8 text-center text-sm text-slate-600">等待 agent 输出…</p>
          )}
        </div>

        {/* 权限卡片 */}
        {session.permissions.map((perm) => (
          <PermissionCard
            key={perm.requestId}
            perm={perm}
            onRespond={(optionId) => void respondPermission(session.sessionId, perm.requestId, optionId)}
          />
        ))}
      </div>

      {/* 输入栏 */}
      <form onSubmit={handleSend} className="flex gap-2 border-t border-slate-800 bg-slate-900/80 px-4 py-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="发送消息给 agent…"
          className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-600 outline-none focus:border-indigo-500"
        />
        <button
          type="submit"
          disabled={!input.trim()}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:bg-slate-700"
        >
          发送
        </button>
      </form>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const meta: Record<string, { label: string; color: string }> = {
    running: { label: "运行中", color: "text-emerald-400" },
    waiting_permission: { label: "等待审批", color: "text-amber-400" },
    done: { label: "已完成", color: "text-slate-500" },
    error: { label: "错误", color: "text-rose-400" },
  };
  const m = meta[status] ?? meta.running;
  return <span className={`text-xs font-medium ${m.color}`}>{m.label}</span>;
}

function EventRow({ event }: { event: SessionEvent }) {
  if (event.type === "text") {
    return <pre className="whitespace-pre-wrap font-mono text-sm text-slate-300">{event.text}</pre>;
  }
  if (event.type === "tool-call") {
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2">
        <span className="text-xs text-indigo-400">工具调用</span>
        <p className="mt-0.5 font-mono text-sm text-slate-300">{event.name}</p>
        {event.summary && <p className="mt-0.5 text-xs text-slate-500">{event.summary}</p>}
      </div>
    );
  }
  if (event.type === "tool-result") {
    return (
      <div className="px-3 py-1 text-xs text-slate-600">
        {event.name} → {event.summary}
      </div>
    );
  }
  if (event.type === "turn-done") {
    return <div className="py-2 text-center text-xs text-slate-600">--- 轮次结束 ({event.reason}) ---</div>;
  }
  if (event.type === "error") {
    return <div className="rounded-lg bg-rose-950/50 px-3 py-2 text-sm text-rose-300">{event.message}</div>;
  }
  return null;
}

function PermissionCard({
  perm,
  onRespond,
}: {
  perm: SessionPermission;
  onRespond: (optionId: string) => void;
}) {
  return (
    <div className="mt-3 rounded-xl border border-amber-700/50 bg-amber-950/30 p-4">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-amber-400">需要审批</span>
        <span className="font-mono text-sm text-slate-200">{perm.toolName}</span>
      </div>
      {perm.summary && <p className="mt-2 font-mono text-xs text-slate-400">{perm.summary}</p>}
      <div className="mt-3 flex gap-2">
        {perm.options.map((opt) => (
          <button
            key={opt.id}
            onClick={() => onRespond(opt.id)}
            className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              opt.id.includes("accept") || opt.id === "allow"
                ? "bg-emerald-600 text-white hover:bg-emerald-500"
                : opt.id.includes("decline") || opt.id === "deny"
                  ? "bg-rose-600 text-white hover:bg-rose-500"
                  : "bg-slate-700 text-slate-200 hover:bg-slate-600"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
