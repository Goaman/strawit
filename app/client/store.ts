// Client state: a reactive list of sessions kept in sync over the websocket,
// plus action helpers that send commands back to the server.

import { createSignal } from "solid-js";
import type {
  ClientMessage,
  ImageAttachment,
  ServerMessage,
  SessionSnapshot,
  TranscriptEntry,
} from "../types.ts";

// Top-level view: the existing agent console, or the local project board.
export const [view, setView] = createSignal<"agents" | "pm">("agents");

export const [sessions, setSessions] = createSignal<SessionSnapshot[]>([]);
export const [selectedId, setSelectedId] = createSignal<string | null>(null);
// When set, the main view focuses this sub-agent's conversation instead of the
// session transcript. Cleared whenever a session row is selected.
export const [selectedSubKey, setSelectedSubKey] = createSignal<string | null>(null);
export const [connected, setConnected] = createSignal(false);

// Select a session and leave any focused sub-agent.
export function selectSession(id: string) {
  setSelectedId(id);
  setSelectedSubKey(null);
}

// Focus a specific sub-agent's conversation (also selects its session).
export function selectSub(sessionId: string, key: string) {
  setSelectedId(sessionId);
  setSelectedSubKey(key);
}

export function selected(): SessionSnapshot | undefined {
  const id = selectedId();
  return sessions().find((s) => s.id === id);
}

let ws: WebSocket | null = null;

function patchSession(id: string, fn: (s: SessionSnapshot) => SessionSnapshot) {
  setSessions((list) => list.map((s) => (s.id === id ? fn(s) : s)));
}

function apply(msg: ServerMessage) {
  switch (msg.type) {
    case "snapshot":
      setSessions(msg.sessions);
      if (!selectedId() && msg.sessions.length) setSelectedId(msg.sessions[0].id);
      break;
    case "session_added":
      setSessions((list) => [...list, { ...msg.session, transcript: [], subAgents: [] }]);
      if (!selectedId()) setSelectedId(msg.session.id);
      break;
    case "session_snapshot":
      // Replace this session's full state (or add it if unseen), e.g. when the
      // server re-attaches to a worker that kept running across a restart.
      setSessions((list) =>
        list.some((s) => s.id === msg.session.id)
          ? list.map((s) => (s.id === msg.session.id ? msg.session : s))
          : [...list, msg.session],
      );
      if (!selectedId()) setSelectedId(msg.session.id);
      break;
    case "session_updated":
      patchSession(msg.session.id, (s) => ({ ...s, ...msg.session }));
      break;
    case "session_removed":
      setSessions((list) => list.filter((s) => s.id !== msg.id));
      break;
    case "entry":
      patchSession(msg.sessionId, (s) => ({
        ...s,
        transcript: [...s.transcript, msg.entry as TranscriptEntry],
      }));
      break;
    case "tree":
      patchSession(msg.sessionId, (s) => ({ ...s, subAgents: msg.subAgents }));
      break;
  }
}

export function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => setConnected(true);
  ws.onclose = () => {
    setConnected(false);
    setTimeout(connect, 1000); // auto-reconnect
  };
  ws.onmessage = (e) => apply(JSON.parse(e.data) as ServerMessage);
}

function send(msg: ClientMessage) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export const actions = {
  create: (input: {
    label?: string;
    prompt: string;
    model?: string;
    cwd?: string;
    images?: ImageAttachment[];
  }) => send({ type: "create", ...input }),
  message: (sessionId: string, text: string, images?: ImageAttachment[]) =>
    send({ type: "send", sessionId, text, images }),
  interrupt: (sessionId: string) => send({ type: "interrupt", sessionId }),
  close: (sessionId: string) => send({ type: "close", sessionId }),
  remove: (sessionId: string) => send({ type: "delete", sessionId }),
};
