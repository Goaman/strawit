# Agent Console

A Bun + SolidJS UI (web **and** terminal) to **launch agents, watch their
transcript stream live, message a running agent at any time, and follow the
recursive sub-agent tree** — with sessions that survive a restart.

Unlike the one-shot `claude -p` super-agent (which reads no stdin and can't be
messaged mid-run), this uses the **Claude Agent SDK** in *streaming-input mode*:
each agent is a long-lived `query()` fed by a queue-backed async generator, so
you can push a new message into a live session whenever you want and it keeps
its context across turns.

Each console agent also gets the **`super_agent` MCP tool**, so it can spawn
nested agents — which can spawn their own, recursively. That lineage is rendered
live as a **sub-agent tree** (sidebar + conversation); click any node to open
that sub-agent's own conversation (its prompt, the agents it spawned, and what
it returned).

## Run (from the repo root)

```bash
bun install        # first time only
bun run start      # web UI  → http://localhost:4317
bun run tui        # terminal UI (same backend; embeds a server if none is up)
```

- `bun run dev` — same as `start` (no file-watch auto-restart). The server
  supervises long-lived agent sessions, so auto-restart is deliberately off:
  a `--watch` reload tears down every live `query()` and often fails to rebind
  the port, leaving the UI stuck "offline". Restart manually after editing
  server code.
- `PORT=8080 bun run start` — change the port (the TUI honours `PORT` too).

The web UI: **+ new agent** → task → launch; type in the composer (⌘/Ctrl+Enter)
to message the running agent. The TUI: `j/k` select · `n` new · `m` message ·
`g` interrupt · `x` close · `q` quit.

## Persistence — agents survive a server restart, *still running*

Each session runs in its own **detached worker process** (`session-worker.ts`)
that owns the long-lived `query()` and the `claude` subprocess it drives. The
web server is just a *supervisor*: it spawns workers, connects to their unix
sockets (`~/.agent-console/workers/<id>.sock`), and relays their events to the
UI. Because the workers are detached, **stopping the server does not kill the
agents** — they keep running idle between turns. When the server starts again it
scans for live worker sockets and **re-attaches** to the running agents: a
mid-turn agent keeps streaming, and you can message it as if nothing happened.

Metadata, transcript and sub-agent tree are also saved under `~/.agent-console/`
(override with `AGENT_CONSOLE_DIR`). A session whose worker has exited (you
`close`d it, or its turn ended and you quit) is **dormant**; sending it a message
spawns a fresh worker that **resumes** the prior SDK session (same id, same
context). `delete` stops the worker and forgets the session for good.

## Auth

No `ANTHROPIC_API_KEY` required: the server points the SDK at your logged-in
`claude` binary (`~/.local/bin/claude`, or set `CLAUDE_BIN`) so it reuses the
CLI's credentials. Set `ANTHROPIC_API_KEY` instead if you prefer.

## Project board (backed by Linear via Soda Straw)

The **Projects** tab is a project board mapped onto Linear: a **Project** is a
Linear project and a **Task** is a Linear issue, all under one Linear team. The
server never talks to Linear directly — every read/write is proxied through the
**Soda Straw gateway** with a scoped agent API key, so credentials, scope, and
audit stay in Soda Straw. Credentials load from **`~/.strawit/.env`** (override
with `STRAWIT_ENV_FILE`) so the server works from any directory; a `.env` in the
cwd or the ambient environment also works and takes precedence:

```bash
SODA_STRAW_GATEWAY_URL=https://<workspace>.straw.../mcp
SODA_STRAW_API_KEY=ssa_...          # scoped agent key (straw: linear, full access)
LINEAR_TEAM_ID=<team uuid>          # the team projects/issues live under
SODA_STRAW_LINEAR_STRAW=linear      # straw name (optional, default "linear")
```

Mapping details:
- `task.notes` ⇄ the issue description; `branch`/`cwd` are stored in a
  `<!-- strawit:meta ... -->` footer appended to the description.
- statuses `todo`/`in_progress`/`done` ⇄ Linear states **Todo**/**In Progress**/
  **Done**; `blocked` is a **`blocked` label** (Linear has no blocked state),
  auto-created on first use.
- Linear's MCP has no hard delete, so **delete is a soft-delete**: the
  issue/project is moved to **Canceled** and filtered out of the board.

Relevant files: `linear-gateway.ts` (gateway client + Python-repr result
parser), `pm-store.ts` (Linear ⇄ board mapping), `pm-api.ts` (`/api/pm/*` REST).

## How it works

```
web (SolidJS) ─┐                 ┌─ AgentManager (supervisor): spawn + connect
tui (ANSI)    ─┴─ ws ─▶ Bun server ─┤   │
                        (hub,        │   └─ unix socket ─▶ session-worker (DETACHED)
                         fan-out)    │                       ├─ query() ── claude (SDK)
              outlives the server ──▶│                       ├─ MessageQueue → push
                                     │                       ├─ super-agent log → SuperTree
                                     │                       └─ persist to ~/.agent-console
                                     └─ on restart: re-attach to live worker sockets
```

- **`server.ts`** — `startServer()`: bundles the client (`Bun.build`, no JSX
  step), serves static files, runs the `/ws` hub (snapshot on connect +
  broadcast). Runs directly or is embedded by the TUI.
- **`agent-manager.ts`** — the **supervisor**. Spawns a detached worker per
  session, connects to its socket, mirrors its state, and forwards events to the
  hub. On startup it re-attaches to any worker that outlived a previous server;
  otherwise it loads the dormant snapshot and spawns a worker on the next message.
- **`session-worker.ts`** — the detached, long-lived **agent process**. Owns the
  streaming-input `query()` + `MessageQueue`, the `super_agent` MCP server pointed
  at its **own isolated log file** (tailed live), and debounced persistence.
  Listens on a unix socket; the first message starts a fresh agent or resumes a
  prior SDK session. Exits only when the agent ends (`done`/`close`) or is deleted.
- **`session-protocol.ts`** — the newline-delimited JSON command/event types
  exchanged over the worker socket, plus the framing helpers.
- **`super-tree.ts`** — pure reducer folding `spawn`/`server_start`/`child_done`
  log events into a lineage tree, stitching parent→child by depth + FIFO order.
- **`persistence.ts`** — JSON-per-session load/save under `~/.agent-console/`,
  plus the worker socket/pid path helpers used to find and re-attach to workers.
- **`client/`** — SolidJS via the `solid-js/html` tagged template (real
  fine-grained reactivity, bundled by Bun — no Babel/Vite).
- **`tui.ts`** — ANSI terminal client over the same websocket. All dynamic text
  is sanitized and fit to exact plain-text widths before colouring, so columns
  never drift regardless of agent output.
- **`types.ts`** — shared server↔client message + session types.

## Verified (real browser + real agents, Chromium via Playwright; TUI via a pty)

- live streaming + bidirectional messaging: haiku agent "17 × 23?" → **391**,
  then a follow-up "add 9" → **400** (remembered prior context);
- recursive sub-agent tree: an agent spawned L1 → L2 → "PONG"; the lineage
  rendered live in sidebar and conversation;
- click-into-sub-agent: opening an L1 node shows its prompt, its spawned L2, and
  its returned answer; the L2 drills down further;
- persistence: sessions reload after restart as dormant and resume on send;
- TUI: renders cleanly (0 column overflow) at 50–90 cols; navigation + send work.
```
