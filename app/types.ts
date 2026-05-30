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
  // Structured input the agent passed to the tool (kind === "tool_use"), kept
  // so the client can render a rich widget instead of a raw JSON string. Omitted
  // when the input is absent or too large to ship (then `text` is the fallback).
  toolInput?: unknown;
  // Images attached to a user message (kind === "user").
  images?: ImageAttachment[];
  ts: number;
}

export interface SessionMeta {
  id: string;
  label: string;
  model: string | null;
  cwd: string;
  // The task (Linear issue id) this session belongs to. Every session is
  // created against a task; a task can own many sessions. Null only for legacy
  // sessions created before tasks were required.
  taskId: string | null;
  status: SessionStatus;
  sdkSessionId: string | null;
  createdAt: number;
  // True while the agent is mid-turn (so the UI can show a spinner / disable nothing).
  busy: boolean;
  // True while a query() is attached. Restored-from-disk sessions start dormant
  // (live: false) and become live again when resumed by sending a message.
  live: boolean;
}

// One request→answer exchange with a sub-agent. The first turn is the prompt it
// was spawned with; further turns are follow-ups sent by the user, each of which
// resumes the sub-agent's underlying `claude` session (so it keeps its context).
export interface SubAgentTurn {
  prompt: string;
  result: string | null;
  status: "running" | "done" | "error";
  startedAt: number;
}

// A nested agent spawned (recursively) via the super_agent MCP tool. depth 1 is
// a direct child of the console agent; deeper levels are agents that spawned
// their own agents. Flat list — the client nests by parentKey.
export interface SubAgentNode {
  key: string;
  pid: number | null; // the sub-agent's MCP-server pid (from its server_start)
  depth: number; // 1 = direct child of the console agent
  parentKey: string | null; // null = child of the session root (console agent)
  model: string | null;
  prompt: string;
  resultPreview: string | null;
  result: string | null; // full final answer (for the detail conversation view)
  status: "spawning" | "running" | "done" | "error";
  startedAt: number;
  // ---- control: interrupt + talk-to (see session-worker.ts) ----
  // The UI addresses interrupt/follow-up commands at this node by its `key`.
  // The spawned `claude` process group leader for the CURRENT turn — the pid the
  // worker signals to interrupt this sub-agent. Null for legacy/unkillable nodes.
  childPid: number | null;
  // The sub-agent's `claude` session id, captured from its JSON output. Lets a
  // follow-up message resume the SAME session (with full context).
  sessionId: string | null;
  // Full back-and-forth with this sub-agent. turns[0] is the spawning prompt;
  // later entries are user follow-ups. The top-level prompt/result/status mirror
  // the latest turn for the sidebar and backward compatibility.
  turns: SubAgentTurn[];
}

export interface SessionSnapshot extends SessionMeta {
  transcript: TranscriptEntry[];
  subAgents: SubAgentNode[];
}

// ---- Project management (backed by Linear via Soda Straw) ----
// Projects map to Linear projects and tasks to Linear issues, all under one
// Linear team. The board talks to Linear through the Soda Straw gateway
// (see app/linear-gateway.ts + app/pm-store.ts).

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done";

export interface Project {
  id: string;
  name: string;
  description: string;
  // Link to the project in Linear (empty if unknown).
  url?: string;
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
  // Optional git worktree name dedicated to this task. Sessions launched for the
  // task are expected to run inside this worktree (create it with
  // `goa project:worktree:add <project> <name>`).
  worktree: string;
  // Link to the issue in Linear (empty if unknown).
  url?: string;
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
  | { type: "create"; label?: string; prompt: string; model?: string; cwd?: string; taskId?: string | null; images?: ImageAttachment[] }
  | { type: "send"; sessionId: string; text: string; images?: ImageAttachment[] }
  | { type: "interrupt"; sessionId: string }
  // Interrupt a single nested sub-agent (and the run it is in the middle of).
  | { type: "interrupt_sub"; sessionId: string; key: string }
  // Interrupt every running nested sub-agent of this session at once.
  | { type: "interrupt_all_subs"; sessionId: string }
  // Send a follow-up to a nested sub-agent — resumes its session with context.
  | { type: "send_sub"; sessionId: string; key: string; text: string }
  | { type: "close"; sessionId: string }
  | { type: "delete"; sessionId: string };
