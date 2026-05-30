# PLAN v2 — "RAVE OF AGENTS: THE BIG TOP" 🎪🔊🤖

A Bun server + browser frontend that turns the live super-agent log
(`~/.claude/super-agent.log`) into a full-blown audiovisual spectacle: a
3D circus dome where a recursively-nested swarm of Claude agents performs as
neon acrobats on a beat-synced dancefloor, scores its own generative soundtrack
from the work it's doing, and is narrated live by an AI Ringmaster — all
projection-mapping-ready and steerable by a VJ and the crowd.

This is v1 pushed dramatically further. Everything in v1 survives. New ambition
lives **above** the MVP line; the safety net lives **below** it.

---

## 0. North Star (the 30-second jaw-drop)

The hall goes black. A single spotlight finds the **root agent** — a giant
breathing orb at the center of a 3D circus dome. The audience taps the screen,
bass hits, and the root *drops a child*: a laser tether whips outward and a new
performer rappels down it onto the next ring, trailing sparks. Then it fans:
2 children, 4, 8, the tree blooming outward in time with a kick drum that is
*itself generated from the spawn events*. A voice (the AI Ringmaster) booms:
*"Depth three, ladies and gentlemen — our acrobat is now researching the
acoustics of this very dome!"* Transcripts stream as glowing ticker tape over
each performer. A child finishes; a comet of light races home up its tether and
the parent flares as it "catches" the return. The whole structure rotates slowly,
pulses with the music, throws volumetric god-rays, and never — even with zero
real agents — goes dark, because the Ringmaster keeps the floor packed.

If only one thing works on stage, it's this loop. Everything else amplifies it.

---

## 1. Vision

A pitch-black hall under the restored **Winter Circus** dome. We render not a
flat canvas but a **3D big-top**: a domed cylindrical space whose floor is a
glowing neon ring-stage and whose ceiling is a starfield of rigging lights. The
recursive agent tree lives in this volume — depth reads as **radial distance and
height**, so the recursion literally climbs and fans outward like trapeze artists
ascending the rigging.

Each agent is a living **performer** with a tiny personality, a voice in the mix,
and a costume colored by its model. Spawning is a bass-drop trapeze launch.
Finishing is a comet home. The soundtrack is not a backing track — it is
**composed live from the agent activity**: every spawn is a note, every depth
level a layer, the swarm's density the energy of the track. An **AI Ringmaster**
calls the action over the PA. A **VJ console** lets an operator bend reality
(camera, palette, intensity, FX) live, and the **crowd** can pulse the floor from
their phones via a QR code.

And it all degrades gracefully: with no real agents, the **Ringmaster Demo**
synthesizes a packed, believable show so the projector is never dark.

---

## 2. Architecture

### 2.1 Server (Bun, stdlib-first)

`Bun.serve({ fetch, websocket })` is the spine. Jobs:

1. **Static serving** — `GET /` → `app/public/index.html`; other paths map to
   `app/public/*` (JS/CSS/wasm/glb) with correct content-types via `Bun.file`.
2. **WebSocket hub** — `GET /ws` upgrades to a WS. The server keeps a `Set` of
   connected sockets and broadcasts every parsed log event as JSON. On connect it
   replays the current in-memory backlog (bounded ring buffer, ~4000 events) so a
   freshly-opened browser instantly shows the existing tree and current scene.
3. **Log tailer** — watches `SUPER_AGENT_LOG` (default
   `~/.claude/super-agent.log`) and streams new JSONL lines (see 2.2).
4. **Control channel** — `GET /control` upgrades to a *separate* WS namespace for
   the **VJ console** and **crowd** clients. Control messages (palette change,
   camera nudge, FX trigger, crowd "pulse") are validated, then broadcast to all
   render clients as `{type:"control", ...}`. Keeps spectacle inputs off the data
   path. (MVP fallback: VJ controls are local keyboard-only; the control WS is the
   ambition layer.)
5. **Mobile crowd page** — `GET /crowd` serves a tiny phone-friendly page with a
   single glowing "PULSE" button + a few emoji reactions; `GET /qr` renders a QR
   to that URL on the big screen.

### 2.2 Log tailing strategy (unchanged core, hardened)

The log is append-only JSONL. The tailer:

- On startup, `stat`s the file; reads it once to seed the backlog (each existing
  line → parsed → backlog + tree state), then remembers the byte offset
  (`lastSize`).
- Uses `fs.watch(logFile)` change notifications, **debounced ~50ms**. On each
  event it `stat`s again; if `size > lastSize` it reads only the new byte range
  via `Bun.file(path).slice(lastSize, size).text()`, splits on `\n`, parses each
  complete line, advances `lastSize`. A partial trailing line is buffered and
  prepended to the next read.
- Handles **truncation/rotation**: if `size < lastSize`, reset `lastSize = 0` and
  re-read from the top.
- If the file doesn't exist yet, poll for its creation every 1s.
- A fallback 1s `setInterval` poll runs alongside `fs.watch` (FSEvents coalescing
  on macOS makes `fs.watch` unreliable for append-only writes).

### 2.3 Data flow

```
~/.claude/super-agent.log  (JSONL, appended by server.mjs)
        │  fs.watch + tail (read new bytes)
        ▼
  tailer.ts  → parse line → raw event {ts,pid,depth,event,...}
        │
        ▼
  model.ts   → fold event into authoritative AgentGraph (nodes + edges + stats)
        │      (also: ring buffer of raw events; derived "musical events")
        ├───────────────► director.ts  → camera/narration cues from graph deltas
        ├───────────────► score.ts      → derive musical events (server-side clock)
        ▼
  hub (Bun.serve websocket) → broadcast {type:"event"|"score"|"cue"} to clients
        │                      + on connect: {type:"snapshot", events, scene}
        ▼  WebSocket (JSON)        ▲
   browser: store.js folds events │  control WS: VJ + crowd inputs
        ▼                          │
   render loop (WebGPU/WebGL2) + WebAudio graph + speech → 3D big-top
```

The **server owns the canonical graph** (snapshot/replay/demo/narration). The
**client re-folds the same event stream** for rendering. Both share the identical
reducer in `app/shared/reducer.js` — one source of truth for "how an event mutates
the tree." New in v2: the server also derives **musical events** and **director
cues** from graph deltas so audio/camera/narration stay consistent across all
clients (important for multi-screen / projection-mapping setups).

### 2.4 The correlation problem (critical — carried from v1)

`spawn` is emitted by the **parent**: `{pid:parentPid, depth, childDepth, model,
prompt}` — no child pid. The child later emits `server_start` with its real pid at
`depth = childDepth`. Stitch without a shared id via the heuristic matcher in
`reducer.js`:

- On `spawn` from `parentPid`: create a **pending child**
  `{parentPid, expectedDepth: childDepth, prompt, model, spawnTs}` on a per-parent
  FIFO queue.
- On `server_start` with `pid=X, depth=D`: bind to the most recent unmatched
  pending child where `expectedDepth===D` (parents at `depth===D-1`, newest spawn
  first). Set `pid`, `parentPid`, `prompt`, `model`. No match (depth 0) → root.
- `child_done` from `parentPid` w/ `childDepth` → resolve the **oldest unresolved**
  child of that parent at that depth as `done`, attach `resultPreview`.
  `child_exit`/`spawn_error`/`depth_limit`/`parse_error` → close out with an error
  state.

Best-effort and pure/unit-testable. Edge cases render as a brief unparented orb
that later snaps to its tether.

### 2.5 Frontend rendering — 3D, with a 2D safety net

- **Primary: WebGPU** via Three.js (r16x WebGPURenderer) for the 3D big-top:
  instanced orbs, additive neon bloom (UnrealBloom-style post), volumetric-ish
  god-rays, tether ribbons, GPU particles. **Automatic fallback to WebGL2** (same
  Three.js scene, WebGLRenderer) if WebGPU is unavailable — and a **Canvas2D flat
  mode** as the ultimate fallback (this is the MVP renderer; see MVP Core).
- Three.js is the one justified dependency (vendored locally under
  `public/vendor/` so there's no install/build step at demo time). The server
  stays pure Bun stdlib.
- **Post-processing FX**: bloom (mandatory for neon), chromatic aberration on
  bass hits, film grain/scanlines, vignette, optional motion-blur on camera moves.
- **Camera**: a cinematic auto-director (see 2.6) orbits the dome, punches in on
  the hottest lineage, and pulls back for "the whole tree" beauty shots. VJ can
  seize manual control at any time.

### 2.6 The Director (auto-cinematography + narration)

`director.ts` (server) + `director.js` (client) turn graph deltas into a show:

- **Camera cues**: new deepest depth → slow push-in + tilt up the rigging; a burst
  of sibling spawns → pull back to reveal the bloom; a long-lived lineage going
  quiet → drift to the next hot cluster. Cues are *suggestions* the client camera
  rig eases toward (so it stays smooth and never jarring).
- **Narration cues**: notable moments (root born, new max depth, "boss drop" at
  `MAX_DEPTH`, a big fan-out, a long error streak) emit a `cue` with a templated
  line. The client speaks it via **WebAudio + SpeechSynthesis** (browser TTS) in a
  Ringmaster voice, ducking the music under the VO. Lines are punchy and on-theme.
  (Stretch: pipe cue text to a Claude call via Soda Straw for live witty
  commentary; MVP uses templates so it works fully offline.)

### 2.7 Audio architecture — generative, not a backing track

`audio/` builds a real WebAudio synth graph whose *content is driven by the agent
activity*:

- **Transport**: a sample-accurate beat clock (BPM ~124, VJ-adjustable) using
  lookahead scheduling. The server's `score.ts` is the authority so all screens
  agree; the client schedules against it.
- **Layered stems by depth**: depth 0 = sub-bass + kick, depth 1 = bassline,
  depth 2 = stabs/chords, depth 3 = arps, depth 4+ = shimmer/percussion. As the
  tree grows deeper, the track gets fuller — the arrangement *is* the recursion.
- **Spawn = a note**: each spawn triggers a quantized note whose pitch maps to
  depth (deeper = higher in a pentatonic/phrygian scale → always musical) and
  whose timbre maps to model. `child_done` triggers a resolving "tail" note.
- **Density → energy**: active-agent count drives filter cutoff, reverb send, and
  a "build/drop" envelope; a sudden swarm triggers a riser → a drop on the next
  bar. Errors get a detuned, gritty stinger.
- **Analyser feedback loop**: an `AnalyserNode` reads the generated mix back into
  the visuals — bass bins drive bloom/zoom, mids drive particle emission. The
  music we *make from the agents* in turn *shapes the light show*. Closed loop.
- **Spatialization (stretch)**: `PannerNode` per depth ring so deeper agents sound
  further out — great on a multi-speaker venue rig.
- Autoplay: a single **"TAP TO ENTER THE TENT"** splash unlocks `AudioContext`.

---

## 3. Visual / game design — the 3D big-top

### 3.1 The stage

A **3D circus dome**: a dark cylindrical hall with a neon ring-stage floor and a
domed ceiling laced with rigging lights. The floor is divided into **concentric
depth rings** (depth 0 center spotlight → `MAX_DEPTH` at the rim). Optionally the
tree also **climbs**: deeper agents can rise toward the rigging, so the structure
reads as a luminous 3D chandelier of performers. Volumetric god-rays from the
center spotlight cut through atmospheric haze.

### 3.2 Agents = performers (with personality)

Each agent node is a glowing performer orb with a costume and a vibe:

- **Size** by depth (root biggest), pulsing on the beat.
- **Color** by `model` (opus = magenta, sonnet = cyan, haiku = lime, unknown =
  white) and **state**: spawning (flare-in), active (steady neon glow + orbiting
  spark familiars), done (cool fade to ember), error (red strobe).
- **Personality**: a deterministic seed from `pid` picks a small behavior set —
  bob speed, spin direction, particle familiars, an emoji "face," and a one-word
  stage name ("Vesper the Tightrope Sonnet"). Purely cosmetic but it makes the
  swarm feel *alive* and gives the Ringmaster something to riff on.
- **Position**: angularly distributed within its depth ring, biased near the
  parent's angle so siblings cluster — lineage reads even before tracing a tether.
- **A force-y settle**: light verlet/spring relaxation so orbs gently avoid
  overlap and the tree "breathes" instead of snapping (cheap, stable, looks great).

### 3.3 Spawns = the drop / the trapeze launch

The `spawn` showpiece, now in 3D:

- A **laser tether** whips from parent → new child position (rigging rope).
- A **bass-drop accent** quantized to the next beat: particle burst at the parent,
  expanding shockwave ring, global bloom spike, chromatic-aberration kick, subtle
  camera shake — and a generated **spawn note** in the mix.
- The child orb **flares in** and rappels down the tether into its ring, trailing
  a comet tail.
- The Director may punch the camera toward a notable spawn.

### 3.4 Lineage = tethers (energy ribbons)

Parent→child edges are persistent glowing **ribbon tethers** (tube/ribbon geometry
along Catmull-Rom curves so deep trees look like rigging, not a hairball). Tethers
pulse with energy flowing **downward** while a child is active. Hover/click lights
the full ancestry root→node at full brightness while dimming the rest — instant
"who spawned whom." The VJ/Director can isolate a single lineage as a spotlight act.

### 3.5 Child done = the pulse home

`child_done` sends a bright **comet** racing **up** the tether to the parent; the
child cools to an ember and shrinks; a small `resultPreview` banner floats up and
dissolves; the parent flares (it "caught" its performer) and a resolving note
sounds. Errors send a red, jagged pulse + gritty stinger instead.

### 3.6 Transcripts = the glowing ticker tape

`prompt` (spawn) and `resultPreview` (child_done) are rendered as glowing
marquee/ticker text above the relevant orb (SDF/MSDF text in 3D, or a Canvas2D
overlay layer for crispness), typed in character-by-character with neon flicker,
then fading. A side **"backstage feed"** panel scrolls the most recent N
transcript snippets, color-coded by depth, readable from the back row.

### 3.7 Leaderboard + stats (the scoreboard)

A neon **scoreboard** panel celebrates the swarm:

- **Deepest dive** (max depth reached + which lineage got there).
- **Busiest parent** (most children spawned).
- **Fastest return** (shortest spawn→child_done).
- **Longest-running act** (still active).
- Live tallies: active / total / spawns-per-minute / error rate / current BPM.

Great for audience engagement and gives the Ringmaster material.

### 3.8 HUD + theming

Minimal neon HUD: live counts, BPM, LIVE/DEMO badge, FPS-safe particle cap. Heavy
vignette, optional scanlines, big readable type, designed for a projector. A small
set of **palette themes** (Classic Neon, Acid, Vaporwave, Mono-Strobe) the VJ can
cycle.

### 3.9 Crowd & VJ interaction

- **Crowd phones** (`/crowd`): a giant PULSE button sends a `control` "pulse" that
  injects a beat-quantized global flash + bloom bump + cheer particle rain. Emoji
  reactions float up the screen. A live "crowd energy" meter feeds the audio build.
- **VJ console** (`/vj`, hidden panel toggled by `~`): sliders/buttons for camera
  mode (auto/manual/orbit), palette, global intensity, FX toggles (grain, shake,
  god-rays), BPM, manual bass-drop, "freeze frame" for photos, and a master
  LIVE/DEMO override.

### 3.10 Projection-mapping readiness

- Resolution-agnostic, true fullscreen, no chrome.
- **Output calibration overlay** (toggle): grid + corner markers; CSS/WebGL
  **keystone/quad-warp** on the final composited canvas so the projection can be
  corner-pinned onto the dome/walls without external mapping software.
- Deterministic seeds + server-authoritative clock so **multiple screens stay in
  sync** for a wraparound install.

---

## 4. File / module breakdown (everything under `app/`)

```
app/
  server.ts              — Bun.serve entry: static routes + /ws + /control + /crowd + /vj; wires tailer→model→hub.
  tailer.ts              — Watches SUPER_AGENT_LOG, reads new bytes, emits parsed JSONL events.
  hub.ts                 — WebSocket fan-out: client set, snapshot-on-connect, broadcast(); data + control channels.
  model.ts               — Server-side authoritative AgentGraph (folds via shared reducer) + derived stats/leaderboard.
  ringbuffer.ts          — Bounded event backlog (~4000) for snapshot/replay.
  demo.ts                — Ringmaster: synthesizes fake spawn/done event streams when log is idle.
  director.ts            — Derives camera + narration cues from graph deltas; broadcasts {type:"cue"}.
  score.ts               — Server-authoritative beat clock + derives musical events {type:"score"} from spawns/dones.
  control.ts             — Validates + relays VJ/crowd control messages to render clients.
  qr.ts                  — Generates a QR (tiny dependency-free SVG/PNG) pointing at the /crowd URL.
  config.ts              — Resolves LOG_FILE, PORT, MAX_DEPTH, DEMO_MODE, BPM from env/flags.

  shared/
    reducer.js           — Pure event→AgentGraph reducer + parent/child correlation matcher (server & client).
    types.ts             — Event + AgentNode + AgentGraph + Cue + ScoreEvent type definitions.
    scale.js             — Musical scale + depth→pitch mapping (shared so server cues and client synth agree).

  public/
    index.html           — Canvas + overlays + "TAP TO ENTER" splash; loads main.js as a module.
    crowd.html           — Phone page: PULSE button + emoji reactions (control WS client).
    vj.html              — VJ console panel (or rendered as an in-app overlay).
    styles.css           — Dark/neon HUD, backstage panel, scoreboard, splash, scanline/vignette FX.
    main.js              — Browser entry: opens WS, drives store + renderer + audio + director + RAF loop.
    store.js             — Client-side graph state: folds incoming events via shared reducer.
    ws.js                — WebSocket client(s) with auto-reconnect + snapshot/score/cue/control handling.
    renderer/
      engine.js          — Renderer abstraction: picks WebGPU → WebGL2 → Canvas2D; owns the frame loop + post FX.
      scene3d.js         — Three.js 3D big-top: dome, ring-stage, lighting, god-rays, camera rig.
      orbs.js            — Instanced performer orbs: model/state materials, beat pulse, personality seeds.
      tethers.js         — Ribbon/tube lineage curves with flowing-energy shader; ancestry highlight.
      particles.js       — GPU particle system: spawn bursts, orbiting familiars, energy comets, crowd cheer.
      camera.js          — Cinematic camera rig: eases toward Director cues; manual/auto/orbit modes.
      overlay.js         — Canvas2D layer: transcript tickers, labels, HUD, backstage feed, scoreboard.
      warp.js            — Final-output keystone/quad-warp + calibration grid for projection mapping.
      flat2d.js          — Canvas2D fallback renderer (the MVP visual): rings, circles, lines, basic FX.
    audio/
      engine.js          — WebAudio graph: kick/bass/stabs/arp/shimmer voices, master bus, AnalyserNode.
      transport.js       — Lookahead beat scheduler synced to server score clock; build/drop envelopes.
      score.js           — Maps ScoreEvents (spawn/done/error) → scheduled notes per depth-layer.
      reactive.js        — Reads analyser → bloom/zoom/emission/shake params each frame.
      narrator.js        — Ringmaster TTS via SpeechSynthesis; ducks music; speaks Director cues.
    util/
      color.js           — Model→neon palette, depth gradients, theme presets, HSL helpers.
      easing.js          — Tween/easing helpers for flares, pulses, camera, screen shake.
      seed.js            — Deterministic per-pid personality/seed helpers.

  scripts/
    emit-fake-log.ts     — Standalone dev tool: append realistic events to a test log to drive the real tail path.
    record.ts            — Capture a live session's events to a .replay file for rehearsed demos.

  README.md              — How to run (bun run), env vars, demo mode, controls, VJ/crowd URLs.
  package.json           — "dev"/"start" scripts (bun run app/server.ts); only vendored Three.js client-side.
```

`shared/reducer.js` and `shared/scale.js` are authored in plain JS so the browser
can `import` them directly and the server can too — no bundler, no build step.
Three.js is vendored under `public/vendor/` and imported as an ES module.

---

## 5. Demo / replay mode (the Ringmaster)

The show must never go dark. `demo.ts` keeps the floor alive — and in v2 the demo
is rich enough to be the *headline* show if no real agents run:

- **Auto-activation**: no new real event for N seconds (default 8s) or no log file
  → Ringmaster turns on. The instant a real event arrives it pauses (real always
  wins). A `LIVE`/`DEMO` badge keeps it honest.
- **Same schema, same path**: generates events with the exact real schema (`ts`,
  `pid`, `depth`, `event`, `childDepth`, `model`, `prompt`, `resultPreview`) pushed
  through the **same hub/reducer/score/director path** — demo and live are visually
  identical and exercise the matcher for real. Fake pids are negative integers.
- **Director-aware behavior model**: a stochastic spawner with *dramatic pacing* —
  it deliberately builds tension (a slow ramp), fans out (a "drop"), holds a deep
  lineage for a beauty shot, occasionally errors for variety, then resets. Tuned so
  the Director and score get satisfying material on a loop. Prompts/result-previews
  pull from a curated on-theme list ("research the acoustics of the Winter Circus
  dome", "summarize the rave setlist", "negotiate with the trapeze AI"…).
- **Three flavors**:
  1. **Live-synth** (default) — events generated in real time with dramatic pacing.
  2. **Replay** — `--replay <file>` re-plays a captured `.replay`/`.log` at a chosen
     speed (re-stamping `ts` to wall-clock) for a deterministic rehearsed demo.
  3. **Scripted showpiece** — `--show` runs a hand-authored ~90s sequence
     engineered for the pitch (intro → build → boss drop at MAX_DEPTH → finale).
- **Dev helper**: `scripts/emit-fake-log.ts` appends synthetic events to a real
  test log so the full `fs.watch`→tail→hub path is tested end-to-end.

Keyboard controls: `D` toggle demo · `M` mute · `Space` manual bass-drop spawn ·
`F` fullscreen · `R` reset camera · `C` cycle camera mode · `P` cycle palette ·
`K` toggle keystone-calibration · `~` VJ console · `N` toggle narrator · `L`
toggle leaderboard.

---

## MVP Core (must ship)

**This is the safety net. If we only build this, the demo still lands.** Everything
above this line is ambition layered on top; nothing here depends on the fancy bits.

1. **Bun server runs**: `bun run app/server.ts` serves `index.html` and a `/ws`
   that connects. Green "connected" badge.
2. **Real log tailing**: `tailer.ts` + `ringbuffer.ts` + `hub.ts` tail
   `~/.claude/super-agent.log`, broadcast each parsed event, and snapshot-on-connect
   so a fresh browser sees the existing tree.
3. **Correct tree**: `shared/reducer.js` folds events into the AgentGraph with the
   parent→child correlation matcher (unit-tested for spawn / server_start /
   child_done stitching).
4. **A visible, correct visual** — the **Canvas2D `flat2d.js` renderer**: agents as
   glowing circles laid out by concentric depth ring, parent→child lines, color by
   model, state changes (spawn flare / active glow / done fade / error red). It does
   *not* need WebGPU/3D to be legible and on-theme.
5. **Demo mode (`demo.ts`)**: auto-activates on an idle/absent log and synthesizes a
   churning tree through the same path, with a LIVE/DEMO badge. **The projector is
   never dark.** Prioritize this early.
6. **Minimal audio + transcripts**: a basic WebAudio four-on-the-floor (kick + bass)
   behind a "TAP TO ENTER" splash, an `AnalyserNode` driving a global bloom/pulse,
   and transcript ticker text + a backstage feed so the audience can read what
   agents are doing.
7. **Graceful degradation**: reconnect on WS drop; handle empty/absent/rotated log;
   particle/FPS caps. Runs on macOS with Bun already installed, no exotic deps.

If WebGPU, 3D, generative scoring, narration, VJ/crowd, leaderboard, or projection
warp aren't finished, the MVP above is a complete, honest, good-looking demo on its
own.

---

## 6. Milestones (MVP first, ambition stacked after)

**M0 — Skeleton (run it).** `Bun.serve` serves a black `index.html` + `/ws`
heartbeat. *Done: page loads, WS badge green.*

**M1 — Real data flowing.** `tailer.ts` + `ringbuffer.ts` + `hub.ts`; browser
`ws.js` + `store.js` log received events. *Done: a real super_agent run (or
appended log lines) shows events in the browser console.*

**M2 — Reducer + flat visual.** `shared/reducer.js` builds the AgentGraph with the
correlation matcher (+ unit tests). `flat2d.js` draws depth-ring circles + lineage
lines. Ugly but correct. *Done: a 3-deep tree renders with correct lineage.*

**M3 — Demo mode (safety milestone).** `demo.ts` Ringmaster + auto-activation +
LIVE/DEMO badge. *Done: `bun run` on an empty log shows a churning tree.*
**→ THIS IS THE DEMO SAFETY NET. Prioritize it before any 3D.**

**M4 — The rave, flat edition.** Spawn bursts, flowing tethers, energy pulses on
done, beat-synced pulses on the Canvas2D renderer; basic WebAudio synth + analyser;
"TAP TO ENTER" splash; transcripts + backstage feed + HUD. *Done: the MVP Core is
fully shippable and looks good on a projector.*

**M5 — Go 3D.** `engine.js` renderer abstraction with WebGPU→WebGL2→Canvas2D
fallback; `scene3d.js` dome + ring-stage + lighting + bloom; `orbs.js` instanced
performers; `tethers.js` ribbons; `camera.js` orbit. *Done: the same tree renders in
the 3D big-top, falling back cleanly when WebGPU is absent.*

**M6 — Generative score + Director.** `score.ts`/`audio/score.js` derive notes from
spawns/dones with layered depth stems and build/drop dynamics; `director.ts` emits
camera + narration cues; `narrator.js` speaks the Ringmaster via TTS. *Done: the
music is visibly driven by agent activity and the camera/narration tell a story.*

**M7 — Spectacle layer.** Personalities + seeds, god-rays, post FX (chromatic
aberration / grain / shake), leaderboard/scoreboard, palette themes, lineage
spotlight. *Done: it's genuinely jaw-dropping full-screen.*

**M8 — Crowd + VJ + projection.** `/control` channel, `/crowd` phone page + QR,
`/vj` console, `warp.js` keystone calibration, multi-screen sync. *Done: an operator
can steer the show and the crowd can pulse the floor from their phones.*

**M9 — Hardening & showpiece.** Reconnect robustness, log rotation/truncation,
particle caps for stable FPS, `--replay` + `--show` scripted sequence, 30-min
soak test. *Done: it survives a live session and has a rehearsed 90s pitch loop.*

Stretch beyond M9: spatial audio per depth ring; Claude-powered live witty
narration via Soda Straw; agent "duels"/mini-games when two lineages cross; a
"hall of fame" persisted across sessions; AR/phone-as-second-screen views.

---

### Run

```bash
bun run app/server.ts                              # http://localhost:3000, tails ~/.claude/super-agent.log
SUPER_AGENT_LOG=./test.log bun run app/server.ts   # point at a test log
bun run app/server.ts --demo                       # force Ringmaster on
bun run app/server.ts --show                        # scripted 90s pitch showpiece
bun run app/server.ts --replay session.replay --speed 1.5   # rehearsed deterministic demo

# audience: open the big screen at /, project it; show /qr so the crowd can join /crowd
# operator: press ~ for the VJ console (or open /vj on a second device)
```
