/**
 * Zustand store：身份 / 设备 / 会话 / 视图状态 + relay 客户端绑定。
 */

import { create } from "zustand";
import {
  type KeyPair,
} from "@agentlink/wire";
import {
  RelayClient,
  type ConnectionStatus,
  type AgentEvent,
  type PermissionRequest,
} from "./lib/relay-client";
import {
  getFingerprint,
  getLatestPeer,
  loadIdentity,
  loadPeers,
  removePeer,
  type StoredPeer,
} from "./lib/identity";

export type View = "sessions" | "pair" | "devices";

export interface SessionEvent {
  type: string;
  text?: string;
  name?: string;
  summary?: string;
  reason?: string;
  message?: string;
  ts: number;
}

export interface SessionPermission {
  requestId: string;
  agent: string;
  toolName: string;
  summary: string;
  options: { id: string; label: string }[];
  ts: number;
}

export interface SessionState {
  sessionId: string;
  agent: string;
  events: SessionEvent[];
  permissions: SessionPermission[];
  status: "running" | "waiting_permission" | "done" | "error";
  lastActivity: number;
}

interface AppState {
  // 身份
  identity: KeyPair | null;
  myFingerprint: string;

  // 设备
  peers: Record<string, StoredPeer>;

  // 连接
  connectionStatus: ConnectionStatus;
  relayUrl: string;

  // 会话
  sessions: Record<string, SessionState>;
  activeSessionId: string | null;

  // 视图
  view: View;

  // 错误
  error: string | null;

  // Actions
  init(): void;
  setRelayUrl(url: string): void;
  setView(view: View): void;
  setActiveSession(sessionId: string | null): void;
  pair(code: string): Promise<void>;
  connectChannel(): Promise<void>;
  disconnect(): void;
  respondPermission(sessionId: string, requestId: string, optionId: string): Promise<void>;
  sendInput(sessionId: string, text: string): Promise<void>;
  removePeerDevice(fingerprint: string): void;
  clearError(): void;
}

// RelayClient 单例（不属于 store 状态，但由 store 管理）
let relayClient: RelayClient | null = null;

function getDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  if (/Win/.test(ua)) return "PC";
  return "Web";
}

function getPlatform(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Mac/.test(ua)) return "macos";
  if (/Win/.test(ua)) return "windows";
  return "web";
}

export const useStore = create<AppState>((set, get) => ({
  identity: null,
  myFingerprint: "",
  peers: {},
  connectionStatus: "disconnected",
  relayUrl: (() => {
    const stored = localStorage.getItem("agentlink:relayUrl");
    if (stored) return stored;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws`;
  })(),
  sessions: {},
  activeSessionId: null,
  view: "sessions",
  error: null,

  init() {
    const identity = loadIdentity();
    const peers = loadPeers();
    set({
      identity,
      myFingerprint: getFingerprint(identity),
      peers,
      view: Object.keys(peers).length > 0 ? "sessions" : "pair",
    });
  },

  setRelayUrl(url) {
    localStorage.setItem("agentlink:relayUrl", url);
    set({ relayUrl: url });
  },

  setView(view) {
    set({ view });
  },

  setActiveSession(sessionId) {
    set({ activeSessionId: sessionId });
  },

  async pair(code) {
    const { identity, relayUrl } = get();
    if (!identity) return;
    set({ error: null });
    try {
      relayClient = new RelayClient(relayUrl);
      relayClient.onConnectionChange = (status) => set({ connectionStatus: status });
      relayClient.onAgentEvent = (e: AgentEvent) => {
        const state = get();
        const existing = state.sessions[e.sessionId] ?? {
          sessionId: e.sessionId,
          agent: e.agent,
          events: [],
          permissions: [],
          status: "running" as const,
          lastActivity: Date.now(),
        };
        const event: SessionEvent = { ...e.event, ts: Date.now() };
        const status: SessionState["status"] =
          e.event.type === "turn-done" ? "done" : e.event.type === "error" ? "error" : "running";
        set({
          sessions: {
            ...state.sessions,
            [e.sessionId]: {
              ...existing,
              events: [...existing.events, event].slice(-500),
              status: existing.status === "waiting_permission" ? existing.status : status,
              lastActivity: Date.now(),
            },
          },
        });
      };
      relayClient.onPermissionRequest = (r: PermissionRequest) => {
        const state = get();
        const existing = state.sessions[r.sessionId] ?? {
          sessionId: r.sessionId,
          agent: r.agent,
          events: [],
          permissions: [],
          status: "running" as const,
          lastActivity: Date.now(),
        };
        const perm: SessionPermission = {
          requestId: r.requestId,
          agent: r.agent,
          toolName: r.toolName,
          summary: r.summary,
          options: r.options,
          ts: Date.now(),
        };
        set({
          sessions: {
            ...state.sessions,
            [r.sessionId]: {
              ...existing,
              permissions: [...existing.permissions, perm],
              status: "waiting_permission",
              lastActivity: Date.now(),
            },
          },
        });
      };

      await relayClient.pair(code, identity, {
        name: getDeviceName(),
        platform: getPlatform(),
      });
      set({ peers: loadPeers(), view: "sessions" });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      relayClient = null;
    }
  },

  async connectChannel() {
    const { relayUrl } = get();
    const peer = getLatestPeer();
    if (!peer) {
      set({ error: "尚未配对任何设备", view: "pair" });
      return;
    }
    set({ error: null });
    try {
      relayClient = new RelayClient(relayUrl);
      relayClient.onConnectionChange = (status) => set({ connectionStatus: status });
      relayClient.onAgentEvent = (e: AgentEvent) => {
        const state = get();
        const existing = state.sessions[e.sessionId] ?? {
          sessionId: e.sessionId,
          agent: e.agent,
          events: [],
          permissions: [],
          status: "running" as const,
          lastActivity: Date.now(),
        };
        const event: SessionEvent = { ...e.event, ts: Date.now() };
        const status: SessionState["status"] =
          e.event.type === "turn-done" ? "done" : e.event.type === "error" ? "error" : "running";
        set({
          sessions: {
            ...state.sessions,
            [e.sessionId]: {
              ...existing,
              events: [...existing.events, event].slice(-500),
              status: existing.status === "waiting_permission" ? existing.status : status,
              lastActivity: Date.now(),
            },
          },
        });
      };
      relayClient.onPermissionRequest = (r: PermissionRequest) => {
        const state = get();
        const existing = state.sessions[r.sessionId] ?? {
          sessionId: r.sessionId,
          agent: r.agent,
          events: [],
          permissions: [],
          status: "running" as const,
          lastActivity: Date.now(),
        };
        const perm: SessionPermission = {
          requestId: r.requestId,
          agent: r.agent,
          toolName: r.toolName,
          summary: r.summary,
          options: r.options,
          ts: Date.now(),
        };
        set({
          sessions: {
            ...state.sessions,
            [r.sessionId]: {
              ...existing,
              permissions: [...existing.permissions, perm],
              status: "waiting_permission",
              lastActivity: Date.now(),
            },
          },
        });
      };
      await relayClient.connectChannel(peer.longTermKey);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      relayClient = null;
    }
  },

  disconnect() {
    relayClient?.disconnect();
    relayClient = null;
    set({ connectionStatus: "disconnected" });
  },

  async respondPermission(sessionId, requestId, optionId) {
    if (!relayClient) return;
    await relayClient.sendPermissionResponse(sessionId, requestId, optionId);
    // 移除已回答的权限请求
    const state = get();
    const session = state.sessions[sessionId];
    if (session) {
      set({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            permissions: session.permissions.filter((p) => p.requestId !== requestId),
            status: "running",
            lastActivity: Date.now(),
          },
        },
      });
    }
  },

  async sendInput(sessionId, text) {
    if (!relayClient) return;
    await relayClient.sendUserInput(sessionId, text);
    // 更新会话状态为 running
    const state = get();
    const session = state.sessions[sessionId];
    if (session) {
      set({
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, status: "running", lastActivity: Date.now() },
        },
      });
    }
  },

  removePeerDevice(fingerprint) {
    removePeer(fingerprint);
    set({ peers: loadPeers() });
  },

  clearError() {
    set({ error: null });
  },
}));
