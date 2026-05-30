# PLAN v1 — "Rave of Agents" 🎪🔊

A Bun server + browser frontend that renders live super-agent activity from
`~/.claude/super-agent.log` as a real-time neon rave / circus simulation.

---

## 1. Vision

A pitch-black hall under the Winter Circus dome. The moment an agent is born it
drops onto a glowing neon dancefloor as a pulsing orb, and every child it spawns
rappels down a laser tether to a deeper ring of the floor — so the whole
recursive agent tree becomes a living, beat-synced light show that breathes with
the work. Transcripts stream as glowing ticker text above each performer, spawns
hit like bass drops with particle bursts and screen shake, and a child finishing
sends a bright pulse racing back up its tether to the parent. With no real agents
running, a Ringmaster demo loop keeps the floor packed so the projector never
goes dark.

---

## 2. Architecture

### 2.1 Server (Bun, stdlib only)

`Bun.serve({ fetch, websocket })` does three jobs:

1. **Static serving** — `GET /` → `app/public/index.html`; other paths map to
   `app/public/*` (JS/CSS/wasm) with correct content-types via `Bun.file`.
2. **WebSocket hub** — `GET /ws` upgrades to a WS. The server keeps a `Set` of
   connected sockets and broadcasts every parsed log event as JSON. On connect it
   first replays the current in-memory event backlog (bounded ring buffer, ~2000
   events) so a freshly-opened browser instantly shows the existing tree.
3. **Log tailer** — watches `SUPER_AGENT_LOG` (default
   `~/.claude/super-agent.log`) and streams new JSONL lines.

### 2.2 Log tailing strategy

The log is append-only JSONL. The tailer:

- On startup, `stat`s the file; reads the whole thing once to seed the backlog
  (each existing line → parsed → backlog + tree state), then remembers the byte
  offset (`lastSize`).
- Uses `fs.watch(logFile)` for change notifications, **debounced ~50ms**. On each
  event it `stat`s again; if `size > lastSize` it reads only the new byte range
  via `Bun.file(path).slice(lastSize, size).text()`, splits on `\n`, parses each
  complete line, and advances `lastSize`. A partial trailing line (no newline) is
  buffered and prepended to the next read.
- Handles **truncation/rotation**: if `size < lastSize`, reset `lastSize = 0` and
  re-read from the top.
- If the file does not exist yet, poll for its creation every 1s (the super-agent
  creates it lazily on first `server_start`).
- A fallback 1s `setInterval` poll runs alongside `fs.watch` because `fs.watch`
  is unreliable for append-only writes on macOS (FSEvents coalescing).

### 2.3 Data flow

```
~/.claude/super-agent.log  (JSONL, appended by server.mjs)
        │  fs.watch + tail (read new bytes)
        ▼
  tailer.js  → parse line → raw event {ts,pid,depth,event,...}
        │
        ▼
  model.js   → fold event into authoritative AgentGraph (nodes + edges)
        │  (also keeps a ring buffer of raw events for replay)
        ▼
  hub (Bun.serve websocket) → broadcast {type:"event", event} to all clients
        │                      + on connect: {type:"snapshot", events:[...]}
        ▼  WebSocket (JSON)
   browser: store.js folds the same events into a client-side graph
        ▼
   render loop (Canvas2D/WebGL) + WebAudio analyser → neon dancefloor
```

The **server owns the canonical graph** (used for snapshot/replay and demo
synthesis); the **client re-folds the same event stream** into its own graph for
rendering. Both share the identical reducer logic in `app/shared/reducer.js` so
there is one source of truth for "how an event mutates the tree."

### 2.4 The correlation problem (critical)

A `spawn` event is emitted by the **parent** and only tells us
`{ pid: parentPid, depth, childDepth, model, prompt }` — it does **not** contain
the child's pid. The child later emits its own `server_start` with its real pid
at `depth = childDepth`. We must stitch parent→child without a shared id.

Heuristic matcher (in `reducer.js`):

- When a `spawn` arrives from `parentPid`, create a **pending child** record:
  `{ parentPid, expectedDepth: childDepth, prompt, model, spawnTs }` pushed onto a
  per-parent FIFO queue.
- When a `server_start` arrives with `pid = X, depth = D`, find the most recent
  unmatched pending child where `expectedDepth === D` (search parents at
  `depth === D-1`, newest spawn first). Bind: that node gets `pid = X`,
  `parentPid`, `prompt`, `model`. If no pending match (e.g. it's the root, depth
  0), create a parentless root node.
- `child_done` from `parentPid` with `childDepth` → resolve the **oldest
  unresolved** child of that parent at that depth as `done`, attaching
  `resultPreview`. `child_exit` / `spawn_error` / `depth_limit` / `parse_error`
  similarly close out the matching child/parent with an error state.

This is best-effort (timestamps + depth + FIFO ordering) and good enough for a
visually-correct tree; edge cases just render as a brief unparented orb that
later snaps to its tether. The matcher is pure and unit-testable.

### 2.5 Frontend rendering

- **WebGL via a thin layer** (regl-style hand-rolled, or PixiJS if a small lib is
  justified — default plan: vanilla WebGL2 + Canvas2D overlay). Particles, glow,
  and tethers in WebGL2 (instanced points + additive blending for neon bloom);
  crisp transcript text + labels in a Canvas2D overlay layer on top.
- **WebAudio**: a generated four-on-the-floor synth (kick + hats + bass) via
  `AudioContext` oscillators/noise, plus an `AnalyserNode`. The render loop reads
  `getByteFrequencyData` each frame; bass bins drive global bloom/zoom pulse, mids
  drive particle emission rate. A beat clock (BPM ~128) schedules visual accents.
  Audio starts muted until the user clicks (browser autoplay policy) — a single
  "TAP TO ENTER THE TENT" splash unlocks it.

---

## 3. Visual / game design — the neon dancefloor

### 3.1 The stage

A dark circular **big-top floor** seen in slight perspective, ringed by neon
trim. The floor is divided into **concentric depth rings**: depth 0 at the
center spotlight, depth 1 the next ring out, … up to `MAX_DEPTH` at the rim. Depth
therefore reads instantly as radial distance — the recursion literally fans
outward like a circus ring of performers.

### 3.2 Agents = performers (orbs)

Each agent node is a glowing orb / spotlight performer:

- **Size** by depth (root biggest) and pulses on the beat.
- **Color** by `model` (opus = magenta, sonnet = cyan, haiku = lime, unknown =
  white) and by **state**: spawning (bright flare-in), active (steady neon glow +
  orbiting particles), done (cool fade to ember), error (red strobe).
- **Position**: angularly distributed within its depth ring, biased to sit near
  its parent's angle so siblings cluster — lineage reads even before you trace a
  tether.

### 3.3 Spawns = the drop / the trapeze launch

A `spawn` event is the showpiece:

- A **laser tether** snaps from parent → new child position (a bright line on the
  depth ring boundary, like a trapeze rope or circus rigging).
- A **bass-drop accent**: particle burst at the parent, a shockwave ring, brief
  global bloom spike + subtle screen shake, synced to the next beat.
- The child orb **flares in** travelling down the tether, settling into its ring.

### 3.4 Lineage = tethers

Parent→child edges are persistent glowing tethers (Catmull-Rom / bezier curves so
deep trees look like circus rigging, not a hairball). Tethers pulse with energy
flowing **downward** while a child is active. The currently-selected lineage (hover
or click) lights up the full ancestry chain root→node at full brightness while
dimming everything else — instant "who spawned whom."

### 3.5 Child done = the pulse home

`child_done` sends a bright **energy pulse** racing back **up** the tether to the
parent, the child orb cools to an ember and shrinks, and a small `resultPreview`
banner floats up and dissolves. The parent flares briefly (it "caught" its
performer). Errors send a red, jagged pulse instead.

### 3.6 Transcripts = the glowing ticker

`prompt` (on spawn) and `resultPreview` (on child_done) are the transcript text.
Each is rendered as a glowing marquee/ticker above the relevant orb, typed in
character-by-character with a neon flicker, then fading. A side **"backstage
feed"** panel also scrolls the most recent N transcript snippets as a readable log
for the audience, color-coded by depth.

### 3.7 HUD

Minimal neon HUD: live counts (active / total / max depth reached), BPM, a
LIVE/DEMO indicator, and an FPS-safe particle cap. Designed to look good
full-screen on a projector — heavy vignette, scanlines optional, big readable
type.

---

## 4. File / module breakdown (everything under `app/`)

```
app/
  server.ts              — Bun.serve entry: static routes + /ws upgrade + wires tailer→hub.
  tailer.ts              — Watches SUPER_AGENT_LOG, reads new bytes, emits parsed JSONL events.
  hub.ts                 — WebSocket fan-out: client set, snapshot-on-connect, broadcast().
  ringbuffer.ts          — Bounded event backlog (~2000) for snapshot/replay.
  demo.ts                — Ringmaster: synthesizes fake spawn/done event streams when log is idle.
  config.ts              — Resolves LOG_FILE, PORT, MAX_DEPTH, DEMO_MODE from env/flags.

  shared/
    reducer.ts           — Pure event→AgentGraph reducer + parent/child correlation matcher (used server & client).
    types.ts             — Event + AgentNode + AgentGraph type definitions (shared TS types).

  public/
    index.html           — Canvas + overlay + "TAP TO ENTER" splash; loads main.js as a module.
    styles.css           — Dark/neon HUD, backstage panel, splash, scanline/vignette FX.
    main.js              — Browser entry: opens WS, drives store + renderer + audio + RAF loop.
    store.js             — Client-side graph state: folds incoming events via shared reducer (bundled).
    ws.js                — WebSocket client with auto-reconnect + snapshot handling.
    renderer/
      gl.js              — WebGL2 context, shader programs, instanced draw helpers, additive bloom.
      scene.js           — Maps AgentGraph → visual entities (orbs, tethers, particles); layout by depth ring.
      particles.js       — GPU-ish particle system: spawn bursts, orbiting dust, energy pulses.
      tethers.js         — Bezier/Catmull-Rom lineage curves with flowing-energy shader.
      overlay.js         — Canvas2D layer: transcript tickers, labels, HUD, backstage feed.
    audio/
      engine.js          — WebAudio synth (kick/hat/bass), master bus, AnalyserNode, BPM clock.
      reactive.js        — Reads analyser → bloom/zoom/emission params each frame; schedules beat accents.
    util/
      color.js           — Model→neon palette, depth gradients, HSL helpers.
      easing.js          — Tween/easing helpers for flares, pulses, screen shake.

  scripts/
    emit-fake-log.ts     — Standalone dev tool: append realistic events to a test log to drive the real tail path.

  README.md              — How to run (bun run), env vars, demo mode, controls.
  package.json           — "dev"/"start" scripts (bun run app/server.ts), no runtime deps ideally.
```

(If the bundler step is undesirable, `shared/reducer.ts` is authored in plain JS
so the browser can `import` it directly and the server can too — avoiding a build
step entirely. Default plan: keep it dependency-light, no bundler; serve JS files
as-is and write `shared/reducer.js` once, imported by both sides.)

---

## 5. Demo / replay mode (the Ringmaster)

The show must never go dark on the projector. `demo.ts` keeps the floor alive:

- **Auto-activation**: if the real log has had **no new event for N seconds**
  (default 8s), or the log file is absent, the Ringmaster turns on. The instant a
  real event arrives, it pauses (real activity always wins). A `LIVE` vs `DEMO`
  badge in the HUD makes the mode obvious and honest.
- **Synthesis**: it generates events with the **exact same schema** as the real
  log (`ts`, `pid`, `depth`, `event`, `childDepth`, `model`, `prompt`,
  `resultPreview`) and pushes them through the **same hub/reducer path** — so demo
  and live are visually indistinguishable and the matcher is exercised for real.
  Fake pids are negative integers to never collide with real pids.
- **Behavior model**: a small stochastic spawner. Each tick, active fake agents
  may `spawn` children (probability decays with depth, hard-capped at
  `MAX_DEPTH`), and outstanding children resolve after a randomized delay with a
  `child_done` (occasionally `child_exit`/`depth_limit` for variety). Prompts and
  result previews pull from a curated list of fun, on-theme strings ("research the
  acoustics of the Winter Circus dome", "summarize the rave setlist", …) so the
  tickers read well on screen.
- **Two demo flavors**:
  1. **Live-synth** (default) — events generated in real time as above.
  2. **Replay** — `--replay <file>` re-plays a captured `.log` at a chosen speed
     (re-stamping `ts` to wall-clock) for a deterministic, rehearsed demo.
- **Dev helper**: `scripts/emit-fake-log.ts` appends synthetic events to a real
  test log file, so the full `fs.watch` → tail → hub path can be tested
  end-to-end without the demo shortcut.

Controls (keyboard): `D` toggle demo, `M` mute audio, `Space` re-trigger a
manual bass-drop spawn burst, `F` fullscreen, `R` reset camera/zoom.

---

## 6. Milestones (MVP first)

**M0 — Skeleton (run it).**
`app/server.ts` with `Bun.serve` serving a black `index.html` + a `/ws` that
echoes a heartbeat. `bun run app/server.ts` opens a page that connects. Proves the
loop end-to-end. *Done when: page loads, WS connected badge is green.*

**M1 — Real data flowing.**
`tailer.ts` + `ringbuffer.ts` + `hub.ts`: tail the real log, broadcast events,
snapshot-on-connect. Browser `ws.js` + `store.js` log received events to console.
*Done when: triggering a real super_agent (or appending to the log) shows events
in the browser console.*

**M2 — The reducer + a flat visual.**
`shared/reducer.js` builds the AgentGraph with the correlation matcher (+ unit
tests for spawn/server_start/child_done stitching). Renderer draws agents as plain
canvas circles laid out by depth ring, with parent→child lines. Ugly but correct.
*Done when: a 3-deep tree renders with correct lineage.*

**M3 — Demo mode.**
`demo.ts` Ringmaster + auto-activation + LIVE/DEMO badge. Now the app is always
alive without any real agents. *Done when: `bun run` on an empty log shows a
churning tree.* **This is the demo-safety milestone — prioritize it early.**

**M4 — The rave (WebGL + audio).**
Swap canvas circles for WebGL2 neon orbs, additive bloom, particle bursts on
spawn, flowing tethers, energy pulses on done. WebAudio synth + analyser:
beat-synced pulses, bass-reactive bloom, "TAP TO ENTER" splash. *Done when: it
looks jaw-dropping on a projector and reacts to the beat.*

**M5 — Transcripts + HUD + circus polish.**
Glowing transcript tickers, backstage feed panel, HUD counts/BPM, lineage
highlight on hover/click, screen shake, vignette/scanlines, keyboard controls,
fullscreen. *Done when: an audience can read what agents are doing and follow
who spawned whom.*

**M6 — Hardening & stretch.**
Reconnect robustness, log rotation/truncation handling, particle caps for stable
FPS, replay mode (`--replay`), and stretch goals: spatial audio per depth ring,
camera that auto-focuses the most active lineage, a "boss drop" effect when depth
hits `MAX_DEPTH`. *Done when: it survives a 30-min live session without degrading.*

---

### Run

```bash
bun run app/server.ts          # serves http://localhost:3000, tails ~/.claude/super-agent.log
SUPER_AGENT_LOG=./test.log bun run app/server.ts   # point at a test log
bun run app/server.ts --demo   # force Ringmaster on
```
