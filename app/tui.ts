// Terminal UI to manage agents. It speaks the same websocket protocol as the
// web client, so the TUI and browser share one backend. If no server is
// running on PORT, it embeds one in-process (which also serves the web UI).
//
// Rendering rule that keeps the layout from breaking: ALL dynamic text is
// sanitized (ANSI/control/emoji stripped) and every cell is fit to an exact
// plain-text width BEFORE any colour codes are wrapped around it. Width math
// therefore never sees an escape sequence, so columns can't drift.

import type {
  ClientMessage,
  ServerMessage,
  SessionSnapshot,
  SubAgentNode,
} from "./types.ts";

const PORT = Number(process.env.PORT || 4317);
const URL_HTTP = `http://localhost:${PORT}`;
const URL_WS = `ws://localhost:${PORT}/ws`;

// ---- ANSI helpers ----
const ESC = "\x1b[";
const A = {
  reset: `${ESC}0m`,
  dim: `${ESC}2m`,
  bold: `${ESC}1m`,
  rev: `${ESC}7m`,
  fg: (n: number) => `${ESC}38;5;${n}m`,
  clear: `${ESC}2J${ESC}H`,
  home: `${ESC}H`,
  hideCursor: `${ESC}?25l`,
  showCursor: `${ESC}?25h`,
};
const STATUS_COLOR: Record<string, number> = {
  starting: 179,
  running: 78,
  idle: 75,
  done: 245,
  error: 203,
};
const STATUS_LABEL: Record<string, string> = {
  starting: "starting",
  running: "running",
  idle: "ready",
  done: "closed",
  error: "error",
};
const KIND_COLOR: Record<string, number> = {
  user: 75,
  assistant: 252,
  tool_use: 78,
  result: 78,
  system: 245,
  error: 203,
};

// ---- text helpers (operate on PLAIN strings only) ----
// Strip ANSI sequences, control chars, and astral/emoji code points (which
// would otherwise be width-2 or split mid-surrogate), then collapse whitespace.
function san(s: unknown): string {
  return String(s ?? "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/[\u{10000}-\u{10FFFF}]/gu, "")
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function fit(s: string, w: number): string {
  if (w <= 0) return "";
  if (s.length > w) return w <= 1 ? s.slice(0, w) : s.slice(0, w - 1) + "…";
  return s + " ".repeat(w - s.length);
}
function wrapPlain(s: string, w: number): string[] {
  if (w <= 1) return [s.slice(0, Math.max(0, w))];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += w) out.push(s.slice(i, i + w));
  return out.length ? out : [""];
}
// Build a colour-wrapped cell of exactly `w` visible columns.
function cell(plain: string, w: number, color = ""): string {
  return color + fit(plain, w) + A.reset;
}

// ---- state ----
let sessions: SessionSnapshot[] = [];
let selectedIdx = 0;
let connected = false;
type Mode = "normal" | "message" | "new";
let mode: Mode = "normal";
let buffer = "";
let flash = "";
let ws: WebSocket | null = null;
let quitting = false;

function selected(): SessionSnapshot | undefined {
  return sessions[selectedIdx];
}

function apply(msg: ServerMessage) {
  switch (msg.type) {
    case "snapshot":
      sessions = msg.sessions;
      break;
    case "session_added":
      sessions = [...sessions, { ...msg.session, transcript: [], subAgents: [] }];
      break;
    case "session_snapshot":
      sessions = sessions.some((s) => s.id === msg.session.id)
        ? sessions.map((s) => (s.id === msg.session.id ? msg.session : s))
        : [...sessions, msg.session];
      break;
    case "session_updated":
      sessions = sessions.map((s) => (s.id === msg.session.id ? { ...s, ...msg.session } : s));
      break;
    case "session_removed":
      sessions = sessions.filter((s) => s.id !== msg.id);
      break;
    case "entry":
      sessions = sessions.map((s) =>
        s.id === msg.sessionId ? { ...s, transcript: [...s.transcript, msg.entry] } : s,
      );
      break;
    case "tree":
      sessions = sessions.map((s) =>
        s.id === msg.sessionId ? { ...s, subAgents: msg.subAgents } : s,
      );
      break;
  }
  if (selectedIdx >= sessions.length) selectedIdx = Math.max(0, sessions.length - 1);
  render();
}

function send(msg: ClientMessage) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ---- rendering ----
// A "line" is a {plain, color} pair; turned into an exact-width coloured cell.
type Line = { plain: string; color: string };

function treeLines(nodes: SubAgentNode[], parent: string | null, indent: number): Line[] {
  const out: Line[] = [];
  for (const n of nodes.filter((x) => x.parentKey === parent)) {
    const glyph = n.status === "running" ? "*" : n.status === "done" ? "+" : n.status === "error" ? "x" : "o";
    const color = A.fg(STATUS_COLOR[n.status] ?? 245);
    const pre = "  ".repeat(indent);
    out.push({ plain: `${pre}${glyph} L${n.depth} ${san(n.prompt) || "(no prompt)"}`, color });
    if (n.resultPreview) {
      out.push({ plain: `${pre}    -> ${san(n.resultPreview)}`, color: A.fg(78) });
    }
    out.push(...treeLines(nodes, n.key, indent + 1));
  }
  return out;
}

function leftColumn(w: number): Line[] {
  if (sessions.length === 0) return [{ plain: "no agents - press n", color: A.dim }];
  const lines: Line[] = [];
  sessions.forEach((s, i) => {
    const sel = i === selectedIdx;
    const status = STATUS_LABEL[s.status] ?? s.status;
    const name = fit(san(s.label), Math.max(1, w - status.length - 1));
    // Selected row reverses; otherwise the row is tinted by its status colour.
    lines.push({
      plain: `${name} ${status}`,
      color: sel ? A.rev : A.fg(STATUS_COLOR[s.status] ?? 250),
    });
    const sub = s.subAgents.length ? `${s.subAgents.length} sub - ` : "";
    const live = s.live ? "" : " (dormant)";
    lines.push({ plain: `  ${sub}${san(s.model) || "default"}${live}`, color: A.dim });
  });
  return lines;
}

function rightColumn(w: number, bodyRows: number): Line[] {
  const s = selected();
  if (!s) return [{ plain: "select or launch an agent", color: A.dim }];

  const pinned: Line[] = [];
  const status = STATUS_LABEL[s.status] ?? s.status;
  pinned.push({
    plain: `${san(s.label)}  [${status}]${s.live ? "" : " dormant"}`,
    color: A.fg(STATUS_COLOR[s.status] ?? 252),
  });
  if (s.subAgents.length) {
    pinned.push({ plain: `sub-agents (${s.subAgents.length}):`, color: A.dim });
    pinned.push(...treeLines(s.subAgents, null, 0));
  }
  pinned.push({ plain: "", color: "" });

  const convo: Line[] = [];
  for (const e of s.transcript) {
    const who =
      e.kind === "tool_use" ? `[${san(e.tool) || "tool"}]` : e.kind === "user" ? "you" : e.kind === "assistant" ? "agent" : e.kind;
    const color = A.fg(KIND_COLOR[e.kind] ?? 250);
    const text = `${who}: ${san(e.text)}`;
    for (const piece of wrapPlain(text, w)) convo.push({ plain: piece, color });
  }

  // pinned header/tree stays; transcript scrolls (show the tail).
  const room = Math.max(1, bodyRows - pinned.length);
  const tail = convo.length > room ? convo.slice(convo.length - room) : convo;
  return [...pinned, ...tail];
}

function render() {
  if (quitting) return;
  const cols = process.stdout.columns || 100;
  const rows = process.stdout.rows || 30;
  const leftW = Math.max(16, Math.min(32, Math.floor(cols * 0.34)));
  const rightW = Math.max(10, cols - leftW - 1);
  const bodyRows = Math.max(1, rows - 4);

  const out: string[] = [];

  // header
  const conn = connected ? `${A.fg(78)}* live${A.reset}` : `${A.fg(203)}* offline${A.reset}`;
  out.push(`${A.bold}Agent Console${A.reset}  ${conn}  ${A.dim}${URL_HTTP}${A.reset}`);
  out.push(`${A.dim}${"-".repeat(cols)}${A.reset}`);

  // body
  const left = leftColumn(leftW);
  const right = rightColumn(rightW, bodyRows);
  for (let r = 0; r < bodyRows; r++) {
    const l = left[r] ?? { plain: "", color: "" };
    const rt = right[r] ?? { plain: "", color: "" };
    out.push(`${cell(l.plain, leftW, l.color)}${A.dim}|${A.reset}${cell(rt.plain, rightW, rt.color)}`);
  }

  // footer (always fit to the terminal width)
  out.push(`${A.dim}${"-".repeat(cols)}${A.reset}`);
  if (mode === "normal") {
    const hint = "j/k move - n new - m message - g interrupt - x close - q quit";
    if (flash) {
      out.push(A.fg(179) + fit(flash, cols) + A.reset);
    } else {
      out.push(cell(hint, cols, A.dim));
    }
  } else {
    const label = mode === "new" ? "new agent prompt" : `message -> ${san(selected()?.label)}`;
    let body = `${label}: ${san(buffer)}_`;
    if (body.length > cols) body = "…" + body.slice(body.length - (cols - 1)); // keep the cursor visible
    out.push(A.fg(75) + body + " ".repeat(Math.max(0, cols - body.length)) + A.reset);
  }

  process.stdout.write(A.home + A.clear + out.join("\n"));
}

// ---- input ----
function setFlash(msg: string) {
  flash = msg;
  render();
  setTimeout(() => {
    if (flash === msg) {
      flash = "";
      render();
    }
  }, 1800);
}

function onKey(str: string) {
  if (mode === "normal") {
    switch (str) {
      case "q":
      case "\x03":
        quit();
        return;
      case "k":
      case "\x1b[A":
        selectedIdx = Math.max(0, selectedIdx - 1);
        break;
      case "j":
      case "\x1b[B":
        selectedIdx = Math.min(sessions.length - 1, selectedIdx + 1);
        break;
      case "n":
        mode = "new";
        buffer = "";
        break;
      case "m":
      case "i":
      case "\r":
        if (selected()) {
          mode = "message";
          buffer = "";
        }
        break;
      case "g":
        if (selected()) {
          send({ type: "interrupt", sessionId: selected()!.id });
          setFlash("interrupt sent");
        }
        break;
      case "x":
        if (selected()) {
          send({ type: "close", sessionId: selected()!.id });
          setFlash("close sent");
        }
        break;
    }
    render();
    return;
  }

  // input modes
  if (str === "\x1b") {
    mode = "normal";
    buffer = "";
    render();
    return;
  }
  if (str === "\r") {
    const text = buffer.trim();
    if (text) {
      if (mode === "new") {
        send({ type: "create", prompt: text });
        setFlash("agent launching…");
      } else if (selected()) {
        send({ type: "send", sessionId: selected()!.id, text });
        setFlash("message sent");
      }
    }
    mode = "normal";
    buffer = "";
    render();
    return;
  }
  if (str === "\x7f" || str === "\b") {
    buffer = buffer.slice(0, -1);
    render();
    return;
  }
  if (str === "\x03") {
    quit();
    return;
  }
  if (str >= " ") {
    buffer += str;
    render();
  }
}

function quit() {
  quitting = true;
  process.stdout.write(A.clear + A.showCursor + A.reset);
  try {
    process.stdin.setRawMode(false);
  } catch {}
  ws?.close();
  process.exit(0);
}

// ---- connection ----
function connect() {
  ws = new WebSocket(URL_WS);
  ws.onopen = () => {
    connected = true;
    render();
  };
  ws.onclose = () => {
    if (quitting) return;
    connected = false;
    render();
    setTimeout(connect, 1000);
  };
  ws.onmessage = (e) => apply(JSON.parse(String(e.data)) as ServerMessage);
  ws.onerror = () => {};
}

async function serverIsUp(): Promise<boolean> {
  try {
    await fetch(URL_HTTP + "/", { signal: AbortSignal.timeout(600) });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await serverIsUp())) {
    const { startServer } = await import("./server.ts");
    await startServer({ port: PORT, quiet: true });
  }

  process.stdout.write(A.hideCursor);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onKey);
  process.stdout.on("resize", render);
  process.on("exit", () => process.stdout.write(A.showCursor));

  connect();
  render();
}

main();
