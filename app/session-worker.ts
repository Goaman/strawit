// A detached, long-lived process that owns ONE interactive Claude session.
//
// This is the piece that makes sessions survive a server restart *without
// killing the agent*. The Agent SDK's `query()` runs in-process and drives a
// `claude` subprocess over in-memory stdio; if it lived inside the web server,
// stopping the server would tear down that pipe and the agent would die. So
// instead each session runs here, in its own process, spawned detached from the
// server. It listens on a unix-domain socket; the server connects as a client
// to stream events and push messages. When the server stops, this process (and
// its `claude` child) keeps running idle between turns; a restarted server just
// reconnects to the socket and carries on.
//
// Lifecycle: spawned by the supervisor with --id/--label/--model/--cwd. If a
// persisted snapshot already exists (a resumed session), it is loaded and the
// first message resumes the prior sdk session; otherwise the first message
// starts a fresh one. The process exits when the agent ends (done/error/close)
// or is deleted — i.e. only once there is no live agent left to preserve.

import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import {
  existsSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type {
  ImageAttachment,
  SessionMeta,
  SessionSnapshot,
  SubAgentNode,
  TranscriptEntry,
  TranscriptKind,
} from "./types.ts";
import { SuperTree, type RawEvent } from "./super-tree.ts";
import {
  loadOne,
  logPathFor,
  pidPathFor,
  remove as removePersisted,
  save,
  socketPathFor,
} from "./persistence.ts";
import { readLines, writeLine, type WorkerCommand, type WorkerEvent } from "./session-protocol.ts";

// --- binary / mcp discovery (identical resolution to the in-process version) ---
const CLAUDE_BIN =
  process.env.CLAUDE_BIN ||
  [
    `${process.env.HOME}/.local/bin/claude`,
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ].find((p) => existsSync(p)) ||
  undefined;
// A concrete executable for the directly-spawned `claude -p --resume` we use to
// talk to a sub-agent (the SDK path above can be undefined; fall back to PATH).
const CLAUDE_EXEC = CLAUDE_BIN || "claude";

const REPO_ROOT = join(import.meta.dir, "..");
const SUPER_AGENT_SERVER =
  process.env.SUPER_AGENT_SERVER ||
  [
    join(REPO_ROOT, ".claude/skills/super-agent/server.mjs"),
    "/Volumes/Goadrive/perso/repos/rave-of-agents/.claude/skills/super-agent/server.mjs",
  ].find((p) => existsSync(p));
const NODE_BIN = process.env.NODE_BIN || Bun.which("node") || "node";
const MAX_DEPTH = process.env.SUPER_AGENT_MAX_DEPTH || "5";

// Same push-anytime async iterable used by the original in-process session.
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(msg: SDKUserMessage) {
    this.items.push(msg);
    this.wake?.();
    this.wake = null;
  }

  close() {
    this.closed = true;
    this.wake?.();
    this.wake = null;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.closed || this.items.length > 0) {
      while (this.items.length > 0) yield this.items.shift()!;
      if (this.closed) break;
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const ID = arg("id")!;
if (!ID) {
  console.error("session-worker: --id is required");
  process.exit(2);
}

class Worker {
  meta: SessionMeta;
  transcript: TranscriptEntry[] = [];
  private nextEntryId = 1;

  private queue: MessageQueue | null = null;
  private q: ReturnType<typeof query> | null = null;
  private started = false; // has the query loop been kicked off yet?

  // Nested-agent lineage (super-agent log tailer).
  readonly logPath: string;
  private subAgentsView: SubAgentNode[] = [];
  private tree = new SuperTree();
  private logFd: number | null = null;
  private logOffset = 0;
  private logBuf = "";
  private logTimer: ReturnType<typeof setInterval> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  // Connected supervisor clients (usually 0 or 1, but a reconnecting server may
  // briefly overlap). Events fan out to all of them.
  private clients = new Set<Socket>();
  private server: Server | null = null;

  constructor() {
    this.logPath = logPathFor(ID);
    // Start from a fresh-session default; init() overrides it from storage if a
    // snapshot exists for this id (a resume).
    this.meta = {
      id: ID,
      label: arg("label") || ID,
      model: arg("model") || null,
      cwd: arg("cwd") || process.cwd(),
      taskId: arg("task-id") || null,
      status: "starting",
      sdkSessionId: null,
      createdAt: Date.now(),
      busy: false,
      live: false,
    };
  }

  // Load any persisted snapshot for this session (the store is over the network,
  // so this is async and runs before listen()).
  async init() {
    const restored = await loadOne(ID);
    if (restored) {
      this.transcript = restored.transcript ?? [];
      this.subAgentsView = restored.subAgents ?? [];
      // Seed the live tree with the restored lineage so a sub-agent can be
      // interrupted or talked-to even before the session itself is resumed.
      this.tree.hydrate(this.subAgentsView);
      // Restored = a resume: dormant until the first message arrives.
      this.meta = { ...restored, busy: false, live: false };
      for (const e of this.transcript) this.nextEntryId = Math.max(this.nextEntryId, e.id + 1);
    }
  }

  snapshot(): SessionSnapshot {
    return { ...this.meta, transcript: this.transcript, subAgents: this.subAgentsView };
  }

  // --- event fan-out + persistence ---
  private broadcast(ev: WorkerEvent) {
    for (const c of this.clients) writeLine(c, ev);
  }

  private schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void save(this.snapshot());
    }, 400);
  }

  private update(patch: Partial<SessionMeta>) {
    this.meta = { ...this.meta, ...patch };
    this.broadcast({ type: "session_updated", session: this.meta });
    this.schedulePersist();
  }

  private addEntry(
    kind: TranscriptKind,
    text: string,
    tool?: string,
    images?: ImageAttachment[],
    toolInput?: unknown,
  ) {
    const entry: TranscriptEntry = {
      id: this.nextEntryId++,
      kind,
      text: text
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ""),
      tool,
      toolInput,
      images: images && images.length ? images : undefined,
      ts: Date.now(),
    };
    this.transcript.push(entry);
    this.broadcast({ type: "entry", sessionId: this.meta.id, entry });
    this.schedulePersist();
  }

  private buildOptions(resume?: string): Record<string, unknown> {
    const options: Record<string, unknown> = {
      cwd: this.meta.cwd,
      permissionMode: "bypassPermissions",
      maxTurns: 100,
      includePartialMessages: false,
    };
    if (this.meta.model) options.model = this.meta.model;
    if (CLAUDE_BIN) options.pathToClaudeCodeExecutable = CLAUDE_BIN;
    if (resume) options.resume = resume;

    if (SUPER_AGENT_SERVER) {
      options.strictMcpConfig = true;
      options.mcpServers = {
        superagent: {
          type: "stdio",
          command: NODE_BIN,
          args: [SUPER_AGENT_SERVER],
          env: {
            ...process.env,
            SUPER_AGENT_DEPTH: "0",
            SUPER_AGENT_MAX_DEPTH: MAX_DEPTH,
            SUPER_AGENT_LOG: this.logPath,
          },
        },
      };
    }
    return options;
  }

  private begin(initialPrompt: string, resume?: string, images?: ImageAttachment[]) {
    this.started = true;
    this.queue = new MessageQueue();
    if (SUPER_AGENT_SERVER) {
      this.logFd = null;
      this.logBuf = "";
      if (resume) {
        // Resuming: the tree was already hydrated from the persisted lineage in
        // init(), so skip the existing log history (start tailing at its end) to
        // avoid re-adding past spawns as duplicate nodes.
        this.logOffset = existsSync(this.logPath) ? statSync(this.logPath).size : 0;
      } else {
        // Fresh session: empty tree, tail the log from the start.
        this.tree = new SuperTree();
        this.logOffset = 0;
      }
      this.startTailer();
    }
    this.update({ live: true });
    this.q = query({ prompt: this.queue, options: this.buildOptions(resume) as any });
    this.pushMessage(initialPrompt, images);
    this.runLoop();
  }

  // Command handler: first message starts/resumes; later ones stream in.
  private onSend(text: string, images?: ImageAttachment[]) {
    if (!this.started) {
      if (this.meta.sdkSessionId) {
        this.addEntry("system", "↻ resuming session");
        this.begin(text, this.meta.sdkSessionId, images);
      } else {
        this.begin(text, undefined, images);
      }
      return;
    }
    this.pushMessage(text, images);
  }

  private pushMessage(text: string, images?: ImageAttachment[]) {
    this.addEntry("user", text, undefined, images);
    this.update({ status: "running", busy: true });
    const content =
      images && images.length
        ? [
            ...images.map((img) => ({
              type: "image" as const,
              source: { type: "base64" as const, media_type: img.mediaType, data: img.data },
            })),
            ...(text ? [{ type: "text" as const, text }] : []),
          ]
        : text;
    this.queue?.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    } as SDKUserMessage);
  }

  private async interrupt() {
    try {
      await this.q?.interrupt();
      this.addEntry("system", "⏹ interrupted by user");
    } catch (e) {
      this.addEntry("error", `interrupt failed: ${String(e)}`);
    }
  }

  // --- sub-agent control: interrupt + talk-to ---

  // Push the current lineage to clients and persist it. Used after we mutate the
  // tree directly (follow-up turns), bypassing the log tailer.
  private flushTree() {
    this.subAgentsView = this.tree.list();
    this.tree.takeDirty(); // we're broadcasting now; don't double-emit from the tailer
    this.broadcast({ type: "tree", sessionId: this.meta.id, subAgents: this.subAgentsView });
    this.schedulePersist();
  }

  // Interrupt one sub-agent: signal its process group. For the spawning run this
  // kills the nested `claude` (its parent's super_agent tool then logs child_exit,
  // which the tailer folds into the node); for a follow-up run we spawned, our own
  // close handler finishes the turn. Killing the group also stops anything it
  // spawned in turn.
  private interruptSub(key: string) {
    const node = this.tree.byKey(key);
    if (!node) {
      this.addEntry("error", `sub-agent ${key} not found`);
      return;
    }
    const pid = node.childPid;
    if (!pid) {
      this.addEntry("system", "can't interrupt this sub-agent — no live process for it");
      return;
    }
    const label = node.prompt ? `"${node.prompt.slice(0, 48)}${node.prompt.length > 48 ? "…" : ""}"` : key;
    try {
      process.kill(-pid, "SIGTERM");
      // Escalate if it ignores the polite signal.
      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }, 2500);
      this.addEntry("system", `⏹ interrupted sub-agent ${label}`);
    } catch {
      // Not a group leader (legacy) or already dead — try the bare pid.
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      this.addEntry("system", `⏹ interrupt sent to sub-agent ${label}`);
    }
  }

  // Talk to a sub-agent: resume its `claude` session with a follow-up message so
  // it answers with full prior context. Runs as an independent `claude -p
  // --resume` the worker owns (the parent agent already got its result), updating
  // the node's turns directly.
  private resumeSub(key: string, text: string) {
    const node = this.tree.byKey(key);
    if (!node) {
      this.addEntry("error", `sub-agent ${key} not found`);
      return;
    }
    if (node.status === "running" || node.status === "spawning") {
      this.addEntry("system", "sub-agent is still working — interrupt it before talking to it");
      return;
    }
    if (!node.sessionId) {
      this.addEntry("system", "can't talk to this sub-agent — its session wasn't captured (it never finished a turn)");
      return;
    }
    if (!SUPER_AGENT_SERVER) {
      this.addEntry("error", "super-agent server unavailable; cannot resume sub-agent");
      return;
    }

    this.tree.startTurn(key, text);
    this.flushTree();

    const mcpConfig = JSON.stringify({
      mcpServers: {
        superagent: {
          type: "stdio",
          command: NODE_BIN,
          args: [SUPER_AGENT_SERVER],
          env: {
            ...process.env,
            // Run this resumed agent at the node's own depth so anything it spawns
            // nests one level below it, just like the original run.
            SUPER_AGENT_DEPTH: String(node.depth),
            SUPER_AGENT_MAX_DEPTH: MAX_DEPTH,
            SUPER_AGENT_LOG: this.logPath,
          },
        },
      },
    });
    const args = [
      "-p",
      text,
      "--resume",
      node.sessionId,
      "--output-format",
      "json",
      "--mcp-config",
      mcpConfig,
      "--strict-mcp-config",
      "--allowedTools",
      "mcp__superagent__super_agent",
      "--permission-mode",
      "bypassPermissions",
      "--max-turns",
      "16",
    ];
    if (node.model) args.push("--model", node.model);

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(CLAUDE_EXEC, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        cwd: this.meta.cwd, // run where the session (and the original sub-agent) runs
        detached: true, // own process group, so interruptSub can signal it
      });
    } catch (e) {
      this.tree.finishTurn(key, false, `failed to start resume: ${String((e as Error)?.message ?? e)}`);
      this.flushTree();
      return;
    }

    this.tree.setChildPid(key, child.pid ?? null);
    this.flushTree();

    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (err += d));
    child.on("error", (e) => {
      this.tree.finishTurn(key, false, `resume failed: ${e.message}`);
      this.flushTree();
    });
    child.on("close", (code) => {
      if (code === 0) {
        try {
          const parsed = JSON.parse(out);
          const txt = String(parsed.result ?? "(no result field)");
          this.tree.finishTurn(key, !parsed.is_error, txt, parsed.session_id ?? null);
        } catch (e) {
          this.tree.finishTurn(key, false, `could not parse resume output: ${(e as Error).message}`);
        }
      } else {
        // Non-zero exit: a user interrupt (signal) or a real failure.
        const why = err.trim() ? err.slice(0, 800) : "(interrupted)";
        this.tree.finishTurn(key, false, why);
      }
      this.flushTree();
    });
  }

  // --- super-agent log tailer (nested-agent lineage) ---
  private startTailer() {
    const poll = () => {
      try {
        if (this.logFd === null) {
          if (!existsSync(this.logPath)) return;
          this.logFd = openSync(this.logPath, "r");
        }
        const size = fstatSync(this.logFd).size;
        if (size < this.logOffset) {
          this.logOffset = 0;
          this.logBuf = "";
        }
        if (size <= this.logOffset) return;
        const len = size - this.logOffset;
        const buf = Buffer.allocUnsafe(len);
        const read = readSync(this.logFd, buf, 0, len, this.logOffset);
        this.logOffset += read;
        this.logBuf += buf.toString("utf8", 0, read);

        let nl: number;
        while ((nl = this.logBuf.indexOf("\n")) !== -1) {
          const line = this.logBuf.slice(0, nl).trim();
          this.logBuf = this.logBuf.slice(nl + 1);
          if (!line) continue;
          try {
            this.tree.apply(JSON.parse(line) as RawEvent);
          } catch {
            /* skip malformed line */
          }
        }
        if (this.tree.takeDirty()) {
          this.subAgentsView = this.tree.list();
          this.broadcast({ type: "tree", sessionId: this.meta.id, subAgents: this.subAgentsView });
          this.schedulePersist();
        }
      } catch {
        /* best-effort polling */
      }
    };
    this.logTimer = setInterval(poll, 300);
  }

  private stopTailer() {
    if (this.logTimer) clearInterval(this.logTimer);
    this.logTimer = null;
    if (this.logFd !== null) {
      try {
        closeSync(this.logFd);
      } catch {
        /* ignore */
      }
      this.logFd = null;
    }
  }

  private async runLoop() {
    try {
      for await (const msg of this.q!) {
        this.handle(msg as any);
      }
      if (this.meta.status !== "error") this.update({ status: "done", busy: false, live: false });
    } catch (e) {
      this.addEntry("error", String((e as Error)?.message ?? e));
      this.update({ status: "error", busy: false, live: false });
    } finally {
      this.stopTailer();
      // The agent has ended — there is nothing left to keep alive. Flush the
      // final state to connected servers, then exit so the session goes dormant
      // (a future message resumes it in a fresh worker).
      void this.shutdown(/* gone */ false);
    }
  }

  private handle(msg: any) {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          this.update({ sdkSessionId: msg.session_id ?? this.meta.sdkSessionId });
          this.addEntry(
            "system",
            `session ready (model: ${msg.model ?? this.meta.model ?? "default"})`,
          );
        }
        return;

      case "assistant": {
        const blocks = msg.message?.content ?? [];
        for (const b of blocks) {
          if (b.type === "text" && b.text?.trim()) {
            this.addEntry("assistant", b.text);
          } else if (b.type === "tool_use") {
            const input = b.input ? JSON.stringify(b.input) : "";
            // Ship the structured input so the client can render a rich widget;
            // skip it when it's too large to keep the transcript payload sane
            // (the truncated `text` then serves as the fallback summary).
            const structured = b.input && input.length <= 16_000 ? b.input : undefined;
            this.addEntry(
              "tool_use",
              input.length > 300 ? input.slice(0, 300) + "…" : input,
              b.name,
              undefined,
              structured,
            );
          }
        }
        this.update({ status: "running", busy: true });
        return;
      }

      case "result": {
        const txt = typeof msg.result === "string" ? msg.result : "";
        const cost =
          typeof msg.total_cost_usd === "number" ? ` ($${msg.total_cost_usd.toFixed(4)})` : "";
        if (msg.subtype && msg.subtype !== "success") {
          this.addEntry("error", `turn ended: ${msg.subtype}${cost}`);
        } else if (txt) {
          this.addEntry("result", `✓ done${cost}`);
        }
        this.update({ status: "idle", busy: false });
        return;
      }

      default:
        return;
    }
  }

  // --- socket server: accept supervisor connections ---
  listen() {
    const sockPath = socketPathFor(ID);
    try {
      if (existsSync(sockPath)) unlinkSync(sockPath); // clear a stale socket
    } catch {
      /* ignore */
    }
    this.server = createServer((sock) => {
      this.clients.add(sock);
      // Greet every new connection with the full current state.
      writeLine(sock, { type: "snapshot", session: this.snapshot() } satisfies WorkerEvent);
      readLines<WorkerCommand>(sock, (c) => this.onCommand(c));
      sock.on("error", () => this.clients.delete(sock));
      sock.on("close", () => this.clients.delete(sock));
    });
    this.server.on("error", (e) => {
      console.error(`session-worker ${ID}: socket error`, e);
      process.exit(1);
    });
    this.server.listen(sockPath, () => {
      writeFileSync(pidPathFor(ID), String(process.pid));
      // Persist a baseline so a server that connects before any send still sees us.
      void save(this.snapshot());
    });
  }

  private onCommand(c: WorkerCommand) {
    switch (c.cmd) {
      case "send":
        this.onSend(c.text, c.images);
        return;
      case "interrupt":
        this.interrupt();
        return;
      case "interrupt_sub":
        this.interruptSub(c.key);
        return;
      case "send_sub":
        this.resumeSub(c.key, c.text);
        return;
      case "close":
        // End the agent gracefully; runLoop's finally will shut us down.
        this.queue?.close();
        if (!this.started) void this.shutdown(false); // never ran — just exit
        return;
      case "delete":
        this.queue?.close();
        void this.shutdown(/* gone */ true);
        return;
    }
  }

  // Tear down and exit. `gone` true means the session is being deleted: erase
  // its on-disk traces and tell the server to forget it. `gone` false means the
  // agent merely ended (resumable): keep the snapshot on disk as dormant.
  private shutting = false;
  private async shutdown(gone: boolean) {
    if (this.shutting) return;
    this.shutting = true;
    this.stopTailer();
    if (this.persistTimer) clearTimeout(this.persistTimer);

    // Await the storage write so the row is gone/persisted before we exit — the
    // store is over the network and a fire-and-forget call would race the exit.
    if (gone) {
      this.broadcast({ type: "gone", id: ID });
      await removePersisted(ID);
      try {
        unlinkSync(this.logPath);
      } catch {
        /* ignore */
      }
    } else {
      // Final dormant snapshot for a future resume.
      await save({ ...this.snapshot(), live: false, busy: false });
    }

    try {
      unlinkSync(socketPathFor(ID));
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(pidPathFor(ID));
    } catch {
      /* ignore */
    }
    this.server?.close();
    // Give buffered socket writes a tick to flush before exiting.
    setTimeout(() => process.exit(0), 100);
  }
}

const worker = new Worker();
await worker.init();
worker.listen();
