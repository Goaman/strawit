// Shared types between the Bun server and the SolidJS client.

export type SessionStatus =
  | "starting" // query() created, waiting for SDK init
  | "running" // agent is actively working on a turn
  | "idle" // turn finished, awaiting the next user message
  | "done" // session closed cleanly
  | "error"; // session ended with an error

// One visible line in a session transcript.
export type TranscriptKind =
  | "user" // a message the human sent
  | "assistant" // assistant text
  | "tool_use" // the agent called a tool
  | "result" // end-of-turn result summary
  | "system" // SDK system/init/notice
  | "error";

// An image attached to a user prompt. `data` is raw base64 (no data: prefix);
// `mediaType` is the MIME type (e.g. "image/png"). Sent to the agent as an
// Anthropic image content block and echoed back in the transcript for display.
export interface ImageAttachment {
  mediaType: string;
  data: string;
  // Optional original filename, shown as a tooltip / alt text.
  name?: string;
}

export interface TranscriptEntry {
  id: number;
  kind: TranscriptKind;
  text: string;
  // Optional extras for richer rendering.
  tool?: string;
  // Images attached to a user message (kind === "user").
  images?: ImageAttachment[];
  ts: number;
}

export interface SessionMeta {
  id: string;
  label: string;
  model: string | null;
  cwd: string;
  status: SessionStatus;
  sdkSessionId: string | null;
  createdAt: number;
  // True while the agent is mid-turn (so the UI can show a spinner / disable nothing).
  busy: boolean;
  // True while a query() is attached. Restored-from-disk sessions start dormant
  // (live: false) and become live again when resumed by sending a message.
  live: boolean;
}

// A nested agent spawned (recursively) via the super_agent MCP tool. depth 1 is
// a direct child of the console agent; deeper levels are agents that spawned
// their own agents. Flat list — the client nests by parentKey.
export interface SubAgentNode {
  key: string;
  pid: number | null;
  depth: number; // 1 = direct child of the console agent
  parentKey: string | null; // null = child of the session root (console agent)
  model: string | null;
  prompt: string;
  resultPreview: string | null;
  result: string | null; // full final answer (for the detail conversation view)
  status: "spawning" | "running" | "done" | "error";
  startedAt: number;
}

export interface SessionSnapshot extends SessionMeta {
  transcript: TranscriptEntry[];
  subAgents: SubAgentNode[];
}

// ---- Project management (local, per-worktree) ----
// A lightweight project board scoped to this worktree. Persisted to a single
// JSON file at the worktree root so each worktree keeps its own board.

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done";

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  notes: string;
  status: TaskStatus;
  // Optional git branch this task is associated with.
  branch: string;
  // Optional working directory the task happens in (also used to launch an agent).
  cwd: string;
  createdAt: number;
  updatedAt: number;
}

export interface PmState {
  projects: Project[];
  tasks: Task[];
}

// ---- Server -> client websocket messages ----
export type ServerMessage =
  | { type: "snapshot"; sessions: SessionSnapshot[] }
  | { type: "session_added"; session: SessionMeta }
  // Full state for a single session — sent when the server (re)attaches to its
  // worker, so clients pick up anything that happened while the server was down.
  | { type: "session_snapshot"; session: SessionSnapshot }
  | { type: "session_updated"; session: SessionMeta }
  | { type: "session_removed"; id: string }
  | { type: "entry"; sessionId: string; entry: TranscriptEntry }
  | { type: "tree"; sessionId: string; subAgents: SubAgentNode[] };

// ---- Client -> server websocket messages ----
export type ClientMessage =
  | { type: "create"; label?: string; prompt: string; model?: string; cwd?: string; images?: ImageAttachment[] }
  | { type: "send"; sessionId: string; text: string; images?: ImageAttachment[] }
  | { type: "interrupt"; sessionId: string }
  | { type: "close"; sessionId: string }
  | { type: "delete"; sessionId: string };
