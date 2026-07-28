import { useStore, type SessionState } from "../store";

const STATUS_META: Record<string, { label: string; color: string }> = {
  running: { label: "运行中", color: "bg-emerald-500/20 text-emerald-400" },
  waiting_permission: { label: "等待审批", color: "bg-amber-500/20 text-amber-400" },
  done: { label: "已完成", color: "bg-slate-600/30 text-slate-400" },
  error: { label: "错误", color: "bg-rose-500/20 text-rose-400" },
};

export default function SessionListView() {
  const { sessions, peers, setActiveSession, setView } = useStore();
  const list = Object.values(sessions).sort((a, b) => b.lastActivity - a.lastActivity);

  if (Object.keys(peers).length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-5 py-20 text-center">
        <p className="text-slate-400">尚未配对任何设备</p>
        <button onClick={() => setView("pair")} className="mt-4 text-indigo-400">
          去配对 →
        </button>
      </div>
    );
  }

  if (list.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-5 py-20 text-center">
        <p className="text-slate-400">暂无活跃会话</p>
        <p className="mt-2 text-sm text-slate-600">在开发机运行 agentlink agent qoder --prompt "..." 启动会话</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 px-3 py-3">
      {list.map((s) => (
        <SessionCard key={s.sessionId} session={s} onClick={() => setActiveSession(s.sessionId)} />
      ))}
    </div>
  );
}

function SessionCard({ session, onClick }: { session: SessionState; onClick: () => void }) {
  const meta = STATUS_META[session.status] ?? STATUS_META.running;
  const lastEvent = session.events[session.events.length - 1];
  const preview =
    lastEvent?.text ??
    lastEvent?.summary ??
    lastEvent?.reason ??
    lastEvent?.message ??
    `${lastEvent?.type ?? ""}`;

  return (
    <button
      onClick={onClick}
      className="w-full rounded-xl border border-slate-800 bg-slate-900 p-4 text-left transition-colors hover:border-slate-700"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-slate-300">{session.agent}</span>
          {session.permissions.length > 0 && (
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-400">
              {session.permissions.length} 待审批
            </span>
          )}
        </div>
        <span className={`rounded-full px-2 py-0.5 text-xs ${meta.color}`}>{meta.label}</span>
      </div>
      <p className="mt-2 truncate text-sm text-slate-500">{preview || "等待输出…"}</p>
      <p className="mt-1 text-xs text-slate-600">{new Date(session.lastActivity).toLocaleTimeString()}</p>
    </button>
  );
}
