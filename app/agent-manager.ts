// Supervises interactive Claude agent sessions — but does NOT run them in this
// process. Each session lives in its own detached `session-worker.ts` process
// that owns the long-lived `query()` and the `claude` subprocess it drives. The
// manager is a *client* of those workers: it spawns them, connects to their
// unix sockets, mirrors their state, and forwards their events to the websocket
// hub.
//
// Why the indirection? So sessions survive a server restart *without killing
// the agent*. When the server stops, the workers (and their `claude` children)
// keep running idle between turns; when it starts again, the manager scans for
// live worker sockets and re-attaches — the agents never died. A session with
// no live worker is dormant; sending it a message spawns a worker that resumes
// the prior sdk session (same transcript, same context).

import { spawn } from "node:child_process";
import { connect as netConnect, type Socket } from "node:net";
import { existsSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type {
  ImageAttachment,
  SessionMeta,
  SessionSnapshot,
  SubAgentNode,
  TranscriptEntry,
} from "./types.ts";
import {
  loadAll,
  logPathFor,
  pidPathFor,
  remove as removePersisted,
  socketPathFor,
  workerOutPathFor,
} from "./persistence.ts";
import { readLines, writeLine, type WorkerCommand, type WorkerEvent } from "./session-protocol.ts";
import { ensureSessionTask } from "./pm-store.ts";
import { gatewayConfigured } from "./linear-gateway.ts";

const WORKER_SCRIPT = join(import.meta.dir, "session-worker.ts");

// First non-empty line of a prompt, trimmed and capped — used to title an
// auto-created task after the message that kicked the session off.
function firstLine(text: string, max = 80): string {
  const line = (text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

type Emit = (event: ManagerEvent) => void;

export type ManagerEvent =
  | { type: "session_added"; session: SessionMeta }
  | { type: "session_snapshot"; session: SessionSnapshot }
  | { type: "session_updated"; session: SessionMeta }
  | { type: "session_removed"; id: string }
  | { type: "entry"; sessionId: string; entry: TranscriptEntry }
  | { type: "tree"; sessionId: string; subAgents: SubAgentNode[] };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Attempt a single unix-socket connection. Resolves with the socket on success,
// or null if the worker isn't listening (no worker / stale socket file).
function tryConnect(path: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const s = netConnect(path);
    const onErr = () => {
      s.destroy();
      resolve(null);
    };
    s.once("error", onErr);
    s.once("connect", () => {
      s.removeListener("error", onErr);
      resolve(s);
    });
  });
}

// Connect, retrying while a freshly-spawned worker comes up (imports the SDK,
// starts listening). ~10s ceiling, then give up.
async function connectWithRetry(path: string, attempts = 100, delayMs = 100): Promise<Socket | null> {
  for (let i = 0; i < attempts; i++) {
    const s = await tryConnect(path);
    if (s) return s;
    await sleep(delayMs);
  }
  return null;
}

function cleanupRuntimeFiles(id: string) {
  for (const p of [socketPathFor(id), pidPathFor(id)]) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

// A manager-side mirror of one session. Holds the latest known state and, when
// the session is live, a socket to its worker.
class Handle {
  meta: SessionMeta;
  transcript: TranscriptEntry[];
  subAgents: SubAgentNode[];

  private sock: Socket | null = null;
  private emit: Emit;
  private onGone: (id: string) => void;
  // Commands queued while a worker is being spawned/connected.
  private pending: WorkerCommand[] = [];
  private connecting: Promise<void> | null = null;

  constructor(snap: SessionSnapshot, emit: Emit, onGone: (id: string) => void) {
    this.emit = emit;
    this.onGone = onGone;
    // Trust nothing about liveness from disk — a worker may have died with the
    // server down. We start dormant; a successful connect flips us live via the
    // worker's own snapshot event.
    this.meta = { ...snap, live: false, busy: false };
    this.transcript = snap.transcript ?? [];
    this.subAgents = snap.subAgents ?? [];
  }

  snapshot(): SessionSnapshot {
    return { ...this.meta, transcript: this.transcript, subAgents: this.subAgents };
  }

  get live(): boolean {
    return this.sock !== null;
  }

  // Try to re-attach to an already-running worker (startup path). Never spawns:
  // if nothing is listening, the session simply stays dormant.
  async reattach() {
    const path = socketPathFor(this.meta.id);
    if (!existsSync(path)) return;
    const sock = await tryConnect(path);
    if (sock) this.attach(sock);
    else cleanupRuntimeFiles(this.meta.id); // stale socket from a dead worker
  }

  // Ensure a worker is running and connected, spawning one if needed.
  private ensureWorker(): Promise<void> {
    if (this.sock) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const path = socketPathFor(this.meta.id);
      let sock = await tryConnect(path); // maybe one is already up
      if (!sock) {
        this.spawnWorker();
        sock = await connectWithRetry(path);
      }
      if (sock) this.attach(sock);
      this.connecting = null;
    })();
    return this.connecting;
  }

  private spawnWorker() {
    cleanupRuntimeFiles(this.meta.id); // clear stale socket before the worker binds
    // Capture worker stdout/stderr to a file (it's detached — no inherited tty).
    const out = openSync(workerOutPathFor(this.meta.id), "a");
    const child = spawn(
      process.execPath,
      [
        WORKER_SCRIPT,
        "--id",
        this.meta.id,
        "--label",
        this.meta.label,
        "--model",
        this.meta.model ?? "",
        "--cwd",
        this.meta.cwd,
        "--task-id",
        this.meta.taskId ?? "",
      ],
      { detached: true, stdio: ["ignore", out, out], env: process.env },
    );
    // Detach fully so the worker outlives this server process.
    child.unref();
  }

  private attach(sock: Socket) {
    this.sock = sock;
    readLines<WorkerEvent>(sock, (ev) => this.onWorkerEvent(ev));
    sock.on("error", () => {});
    sock.on("close", () => this.onDisconnect());
    // Flush anything queued while we were connecting.
    for (const c of this.pending) writeLine(sock, c);
    this.pending = [];
  }

  private onDisconnect() {
    this.sock = null;
    // The worker exited (turn ended / closed) or we otherwise lost it. If we
    // still thought it was live, mark dormant so the UI stops showing it active.
    if (this.meta.live) {
      this.meta = { ...this.meta, live: false, busy: false };
      this.emit({ type: "session_updated", session: this.meta });
    }
  }

  private onWorkerEvent(ev: WorkerEvent) {
    switch (ev.type) {
      case "snapshot":
        this.meta = ev.session;
        this.transcript = ev.session.transcript ?? [];
        this.subAgents = ev.session.subAgents ?? [];
        this.emit({ type: "session_snapshot", session: this.snapshot() });
        return;
      case "session_updated":
        this.meta = ev.session;
        this.emit({ type: "session_updated", session: this.meta });
        return;
      case "entry":
        this.transcript.push(ev.entry);
        this.emit({ type: "entry", sessionId: ev.sessionId, entry: ev.entry });
        return;
      case "tree":
        this.subAgents = ev.subAgents;
        this.emit({ type: "tree", sessionId: ev.sessionId, subAgents: ev.subAgents });
        return;
      case "gone":
        this.emit({ type: "session_removed", id: ev.id });
        this.onGone(ev.id);
        return;
    }
  }

  private command(c: WorkerCommand) {
    if (this.sock) {
      writeLine(this.sock, c);
      return;
    }
    this.pending.push(c);
    this.ensureWorker();
  }

  send(text: string, images?: ImageAttachment[]) {
    this.command({ cmd: "send", text, images });
  }

  interrupt() {
    if (this.sock) writeLine(this.sock, { cmd: "interrupt" });
  }

  // Interrupt / talk-to a single nested sub-agent. These go through command(),
  // which spawns + connects a worker first if the session is dormant — so you can
  // act on a sub-agent of a session whose worker has exited.
  interruptSub(key: string) {
    this.command({ cmd: "interrupt_sub", key });
  }

  interruptAllSubs() {
    this.command({ cmd: "interrupt_all_subs" });
  }

  sendSub(key: string, text: string) {
    this.command({ cmd: "send_sub", key, text });
  }

  close() {
    if (this.sock) writeLine(this.sock, { cmd: "close" });
  }

  // Forget the session for good. A live worker is told to erase itself and
  // exit (it emits `gone`); a dormant one is cleaned up here directly.
  delete() {
    if (this.sock) {
      writeLine(this.sock, { cmd: "delete" });
      return;
    }
    cleanupRuntimeFiles(this.meta.id);
    removePersisted(this.meta.id);
    try {
      if (existsSync(logPathFor(this.meta.id))) unlinkSync(logPathFor(this.meta.id));
    } catch {
      /* ignore */
    }
    this.emit({ type: "session_removed", id: this.meta.id });
    this.onGone(this.meta.id);
  }
}

export class AgentManager {
  private handles = new Map<string, Handle>();
  private emit: Emit;
  private seq = 0;

  constructor(emit: Emit) {
    this.emit = emit;
  }

  // Async because the session store (Supabase) is loaded over the network. Use
  // AgentManager.start() rather than `new AgentManager()` so callers await this.
  static async start(emit: Emit): Promise<AgentManager> {
    const m = new AgentManager(emit);
    for (const snap of await loadAll()) {
      const h = new Handle(snap, emit, (id) => m.handles.delete(id));
      m.handles.set(snap.id, h);
      const n = Number(snap.id.match(/^s(\d+)-/)?.[1] ?? 0);
      m.seq = Math.max(m.seq, n);
    }
    // Re-attach to any workers that outlived a previous server, in the
    // background — list() already returns the dormant snapshots immediately, and
    // a successful re-attach emits a session_snapshot that updates clients.
    for (const h of m.handles.values()) void h.reattach();
    return m;
  }

  list(): SessionSnapshot[] {
    return [...this.handles.values()].map((h) => h.snapshot());
  }

  async create(input: {
    label?: string;
    prompt: string;
    model?: string;
    cwd?: string;
    taskId?: string | null;
    images?: ImageAttachment[];
  }): Promise<SessionMeta> {
    const id = `s${++this.seq}-${Date.now().toString(36)}`;
    const label = input.label?.trim() || `agent ${this.seq}`;
    const cwd = input.cwd?.trim() || process.cwd();
    const model = input.model?.trim() || null;

    // Every session belongs to a task. If the caller didn't pick one, auto-create
    // a task so the session is still tracked on the board — the user no longer has
    // to choose by hand. If the board (Linear) is unreachable/unconfigured we fall
    // back to a task-less session so launching never hard-fails on Linear.
    let taskId = input.taskId?.trim() || null;
    if (!taskId && gatewayConfigured()) {
      try {
        taskId = await ensureSessionTask({
          title: input.label?.trim() || firstLine(input.prompt),
          notes: input.prompt,
          cwd: input.cwd,
        });
      } catch (err) {
        console.error("[agent-manager] auto-create task failed; launching without one:", err);
      }
    }

    const meta: SessionMeta = {
      id,
      label,
      model,
      cwd,
      taskId,
      status: "starting",
      sdkSessionId: null,
      createdAt: Date.now(),
      busy: true,
      live: false,
    };
    const h = new Handle({ ...meta, transcript: [], subAgents: [] }, this.emit, (rid) =>
      this.handles.delete(rid),
    );
    this.handles.set(id, h);
    this.emit({ type: "session_added", session: meta });
    h.send(input.prompt, input.images); // spawns the worker and starts the agent
    return meta;
  }

  // Live or dormant: the handle spawns/connects a worker as needed, then the
  // worker either pushes the message into the running agent or resumes it.
  send(id: string, text: string, images?: ImageAttachment[]) {
    this.handles.get(id)?.send(text, images);
  }

  async interrupt(id: string) {
    this.handles.get(id)?.interrupt();
  }

  interruptSub(id: string, key: string) {
    this.handles.get(id)?.interruptSub(key);
  }

  interruptAllSubs(id: string) {
    this.handles.get(id)?.interruptAllSubs();
  }

  sendSub(id: string, key: string, text: string) {
    this.handles.get(id)?.sendSub(key, text);
  }

  close(id: string) {
    this.handles.get(id)?.close();
  }

  delete(id: string) {
    this.handles.get(id)?.delete();
  }
}
