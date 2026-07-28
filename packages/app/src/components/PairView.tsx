import { useState } from "react";
import { useStore } from "../store";

export default function PairView() {
  const { pair, connectionStatus, error, clearError, relayUrl, setRelayUrl, myFingerprint } = useStore();
  const [code, setCode] = useState("");
  const [editingRelay, setEditingRelay] = useState(false);
  const [relayInput, setRelayInput] = useState(relayUrl);
  const busy = connectionStatus === "connecting" || connectionStatus === "pairing";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || busy) return;
    void pair(code.trim());
  };

  return (
    <div className="flex flex-col items-center px-5 py-8">
      <div className="mb-8 w-full text-center">
        <h2 className="text-xl font-semibold text-slate-100">配对新设备</h2>
        <p className="mt-1 text-sm text-slate-400">在开发机运行 agentlink pair，将生成的配对码填入下方</p>
      </div>

      <form onSubmit={handleSubmit} className="w-full space-y-4">
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="NNNN-XXXXXX"
          disabled={busy}
          autoComplete="off"
          autoCapitalize="characters"
          className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-center font-mono text-2xl tracking-widest text-slate-100 placeholder-slate-600 outline-none focus:border-indigo-500"
        />

        {error && (
          <div className="rounded-lg border border-rose-800 bg-rose-950/50 px-4 py-2 text-sm text-rose-300">
            {error}
            <button onClick={clearError} className="ml-2 text-rose-500 underline">
              关闭
            </button>
          </div>
        )}

        <button
          type="submit"
          disabled={busy || code.length < 11}
          className="w-full rounded-xl bg-indigo-600 py-3 font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-700"
        >
          {busy ? "配对中…" : "配对"}
        </button>
      </form>

      {/* Relay 地址设置 */}
      <div className="mt-8 w-full border-t border-slate-800 pt-4">
        {editingRelay ? (
          <div className="flex gap-2">
            <input
              value={relayInput}
              onChange={(e) => setRelayInput(e.target.value)}
              className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500"
            />
            <button
              onClick={() => {
                setRelayUrl(relayInput);
                setEditingRelay(false);
              }}
              className="rounded-lg bg-slate-700 px-3 py-2 text-sm text-slate-200"
            >
              保存
            </button>
          </div>
        ) : (
          <button onClick={() => setEditingRelay(true)} className="text-xs text-slate-500">
            relay: {relayUrl}
          </button>
        )}
      </div>

      <div className="mt-4 text-xs text-slate-600">
        本机指纹: <span className="font-mono">{myFingerprint.slice(0, 23)}…</span>
      </div>
    </div>
  );
}
