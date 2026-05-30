// Client state: a reactive list of sessions kept in sync over the websocket,
// plus action helpers that send commands back to the server.

import { createSignal } from "solid-js";
import type {
  ClientMessage,
  ImageAttachment,
  PmState,
  ServerMessage,
  SessionSnapshot,
  Task,
  TranscriptEntry,
} from "../types.ts";

// Top-level view: the existing agent console, or the local project board.
// Persisted to localStorage so the active tab survives a page reload.
const VIEW_KEY = "strawit.view";
function loadView(): "agents" | "pm" | "game" {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === "agents" || v === "pm" || v === "game") return v;
  } catch {
    /* localStorage may be unavailable (private mode, etc.) — fall back */
  }
  return "agents";
}
const [view, setViewRaw] = createSignal<"agents" | "pm" | "game">(loadView());
export { view };
export function setView(v: "agents" | "pm" | "game") {
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    /* ignore persistence failures */
  }
  return setViewRaw(v);
}

export const [sessions, setSessions] = createSignal<SessionSnapshot[]>([]);

// Shared project-board state. Both the board view (pm.ts) and the agent console
// (the "+ new agent" form needs a task picker) read it, so it lives here rather
// than inside pm.ts. Mutations in pm.ts write back here too.
export const [board, setBoard] = createSignal<PmState>({ projects: [], tasks: [] });

// Fetch the board once (best-effort). Used by the new-agent form to populate its
// task picker without forcing the user to open the Projects tab first.
export async function loadBoard(): Promise<void> {
  try {
    const r = await fetch("/api/pm");
    if (r.ok) setBoard(await r.json());
  } catch {
    /* board is optional context here — ignore load failures */
  }
}

// Look up a task by id across the loaded board (for labelling sessions).
export function taskById(id: string | null | undefined): Task | undefined {
  if (!id) return undefined;
  return board().tasks.find((t) => t.id === id);
}
// The selected session id and focused sub-agent are persisted to localStorage
// so the active conversation survives a page reload.
const SELECTED_KEY = "strawit.selectedId";
const SELECTED_SUB_KEY = "strawit.selectedSubKey";
function loadStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storeValue(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* ignore persistence failures (private mode, etc.) */
  }
}

const [selectedId, setSelectedIdRaw] = createSignal<string | null>(loadStored(SELECTED_KEY));
export { selectedId };
export function setSelectedId(id: string | null) {
  storeValue(SELECTED_KEY, id);
  return setSelectedIdRaw(id);
}
// When set, the main view focuses this sub-agent's conversation instead of the
// session transcript. Cleared whenever a session row is selected.
const [selectedSubKey, setSelectedSubKeyRaw] = createSignal<string | null>(
  loadStored(SELECTED_SUB_KEY),
);
export { selectedSubKey };
export function setSelectedSubKey(key: string | null) {
  storeValue(SELECTED_SUB_KEY, key);
  return setSelectedSubKeyRaw(key);
}
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
    case "snapshot": {
      setSessions(msg.sessions);
      // Honour a persisted selection if it still exists; otherwise fall back to
      // the first session (and drop a stale sub-agent focus).
      const cur = selectedId();
      if (msg.sessions.length && !msg.sessions.some((s) => s.id === cur)) {
        setSelectedId(msg.sessions[0].id);
        setSelectedSubKey(null);
      }
      break;
    }
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
    taskId?: string | null;
    images?: ImageAttachment[];
  }) => send({ type: "create", ...input }),
  message: (sessionId: string, text: string, images?: ImageAttachment[]) =>
    send({ type: "send", sessionId, text, images }),
  interrupt: (sessionId: string) => send({ type: "interrupt", sessionId }),
  close: (sessionId: string) => send({ type: "close", sessionId }),
  remove: (sessionId: string) => send({ type: "delete", sessionId }),
};
