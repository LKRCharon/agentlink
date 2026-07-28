import { useEffect } from "react";
import { useStore } from "./store";
import PairView from "./components/PairView";
import SessionListView from "./components/SessionListView";
import SessionDetailView from "./components/SessionDetailView";
import DeviceListView from "./components/DeviceListView";

export default function App() {
  const { init, view, activeSessionId, connectionStatus, peers } = useStore();

  useEffect(() => {
    init();
  }, [init]);

  // 有已配对设备且未连接时自动连接通道
  const connected = connectionStatus === "channel-ready";
  useEffect(() => {
    if (!connected && Object.keys(peers).length > 0 && connectionStatus === "disconnected") {
      useStore.getState().connectChannel();
    }
  }, [connected, peers, connectionStatus]);

  // 有活跃会话时显示详情页
  if (activeSessionId) {
    return <SessionDetailView />;
  }

  return (
    <div className="mx-auto flex h-full max-w-md flex-col bg-slate-950">
      <header className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
        <div className="flex items-center gap-2">
          <span className="text-lg font-semibold tracking-tight text-slate-100">agentlink</span>
          <ConnectionDot status={connectionStatus} />
        </div>
        {Object.keys(peers).length > 0 && (
          <span className="text-xs text-slate-500">{Object.keys(peers).length} 台设备</span>
        )}
      </header>

      <main className="flex-1 overflow-y-auto scrollbar-thin">
        {view === "pair" && <PairView />}
        {view === "sessions" && <SessionListView />}
        {view === "devices" && <DeviceListView />}
      </main>

      <nav className="flex border-t border-slate-800 bg-slate-900/80 backdrop-blur">
        <NavButton active={view === "sessions"} onClick={() => useStore.getState().setView("sessions")} label="会话" />
        <NavButton active={view === "pair"} onClick={() => useStore.getState().setView("pair")} label="配对" />
        <NavButton active={view === "devices"} onClick={() => useStore.getState().setView("devices")} label="设备" />
      </nav>
    </div>
  );
}

function ConnectionDot({ status }: { status: string }) {
  const color =
    status === "channel-ready" ? "bg-emerald-400" : status === "disconnected" ? "bg-slate-600" : "bg-amber-400";
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}

function NavButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-3 text-sm font-medium transition-colors ${
        active ? "text-indigo-400" : "text-slate-500 hover:text-slate-300"
      }`}
    >
      {label}
    </button>
  );
}
