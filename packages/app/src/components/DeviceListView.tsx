import { useStore } from "../store";

export default function DeviceListView() {
  const { peers, removePeerDevice, connectionStatus, connectChannel, disconnect, myFingerprint } = useStore();
  const list = Object.values(peers).sort((a, b) => b.pairedAt - a.pairedAt);
  const connected = connectionStatus === "channel-ready";

  return (
    <div className="px-4 py-4">
      {/* 连接状态 */}
      <div className="mb-4 flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900 px-4 py-3">
        <div>
          <p className="text-sm text-slate-300">通道状态</p>
          <p className="text-xs text-slate-500">
            {connected ? "已连接" : connectionStatus === "connecting" ? "连接中…" : "未连接"}
          </p>
        </div>
        {connected ? (
          <button onClick={disconnect} className="rounded-lg bg-slate-700 px-3 py-1.5 text-sm text-slate-200">
            断开
          </button>
        ) : (
          <button
            onClick={() => void connectChannel()}
            disabled={list.length === 0}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm text-white disabled:bg-slate-700"
          >
            连接
          </button>
        )}
      </div>

      {/* 设备列表 */}
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-600">已配对设备</h3>
      {list.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-600">尚未配对任何设备</p>
      ) : (
        <div className="space-y-2">
          {list.map((peer) => (
            <div key={peer.fingerprint} className="rounded-xl border border-slate-800 bg-slate-900 p-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-medium text-slate-200">{peer.deviceName}</p>
                  <p className="text-xs text-slate-500">{peer.platform}</p>
                </div>
                <button
                  onClick={() => removePeerDevice(peer.fingerprint)}
                  className="text-xs text-rose-500 hover:text-rose-400"
                >
                  移除
                </button>
              </div>
              <p className="mt-2 font-mono text-xs text-slate-600">{peer.fingerprint}</p>
              <p className="mt-1 text-xs text-slate-700">{new Date(peer.pairedAt).toLocaleString()}</p>
            </div>
          ))}
        </div>
      )}

      {/* 本机信息 */}
      <div className="mt-8 border-t border-slate-800 pt-4">
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-600">本机</h3>
        <p className="font-mono text-xs text-slate-500">{myFingerprint}</p>
      </div>
    </div>
  );
}
