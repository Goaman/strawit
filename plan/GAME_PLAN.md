# GAME VIEW — Implementation Plan

A live, real-time pixel-art visualization of the agents currently working. A new
top-level **"Game"** tab (after "Projects") renders an HTML5 canvas "arena" where
each agent session — and each sub-agent — is a walking pixel-art sprite. Driven
entirely by the existing live `sessions()` signal over the websocket.

This plan is concrete and self-contained: another engineer can implement it
without re-exploring. All paths are absolute under the worktree
`/Users/goaman/.goapower/worktrees/strawit/agent-game`.

---

## 0. Confirmed environment facts (do not re-verify)

- **Frontend**: SolidJS via `solid-js/html` tagged templates (NO JSX). Bundled by
  `Bun.build` in `app/server.ts` from `app/client/main.ts` -> `app/public/client.js`.
  `client.js` is gitignored and rebuilt every time the server starts. No build step
  beyond `bun run app/server.ts` (default `PORT 4317`).
- **Routing**: `app/client/store.ts` holds `const [view, setViewRaw] = createSignal<"agents"|"pm">(loadView())`,
  persisted to localStorage key `"strawit.view"`. Exports `view` and `setView(v)`,
  plus a `loadView()` that validates stored values.
- **Tabs / routing branch**: `app/client/main.ts` `TopNav()` renders
  `tab("agents","Agents")` then `tab("pm","Projects")`. `App()` switches:
  `view()==="pm" ? PmView : (agents grid layout)`.
- **Live data**: `sessions()` -> `SessionSnapshot[]` (see `app/types.ts`). Per session:
  `id`, `label`, `model`, `status` ("starting"|"running"|"idle"|"done"|"error"),
  `busy` (boolean), `taskId`, `subAgents` (`SubAgentNode[]`: `key`, `depth`,
  `parentKey`, `status` "spawning"|"running"|"done"|"error", `prompt`, `model`).
  The websocket keeps `sessions()` reactive.
- **Shell layout** (`app/public/styles.css`): `.root-shell { height:100vh; display:flex;
  flex-direction:column }`. Top nav is `38px`. View containers use `flex:1; min-height:0`.
  Theme tokens: `--bg #0d0f14`, `--panel #141821`, `--panel2 #1b2030`, `--border #262d3d`,
  `--text #e6e9f0`, `--dim #8b93a7`, `--accent #6ea8fe`, `--accent2 #b78bff`,
  `--radius 5px`, `--hover #1a2030`, `--sel #20283b`.
- **Static serving**: `app/server.ts` serves files from `app/public/` with content-type
  by extension. PNG would currently fall through to `application/octet-stream` — that is
  fine for `<img>`/canvas image loading, but ADD a `png` content type for cleanliness.
- **Gemini keys**: live in `~/.env_ai` (keys `GEMINI_API_KEY` and
  `GOOGLE_GENERATIVE_AI_API_KEY`, both present). NOTE: the app's `app/env.ts` loads
  `~/.strawit/.env`, NOT `~/.env_ai`. The sprite-generation SCRIPT therefore must read
  `~/.env_ai` directly (it does not run inside the server). Model: `gemini-3-pro-image`.
- **gitignore gotcha**: `.gitignore` contains a blanket `*.png` rule. Committed sprite
  PNGs WILL be ignored unless we add a negation. (See step 6.)

---

## 1. Files to create / edit (overview)

CREATE:
- `app/client/game.ts` — the `GameView` SolidJS component + canvas engine.
- `scripts/gen-sprites.ts` — Bun script that calls Gemini and writes sprite PNGs.
- `app/public/sprites/` — output directory for committed sprite PNGs + a manifest.
- `app/public/sprites/manifest.json` — describes each sprite sheet (frame geometry).

EDIT:
- `app/client/store.ts` — extend the `view` union to include `"game"` in three places.
- `app/client/main.ts` — import `GameView`, add the `tab("game","Game")`, add a route branch.
- `app/public/styles.css` — add `.game-*` styles.
- `app/server.ts` — add `png` (and `json`) content types; OPTIONAL regen endpoint.
- `.gitignore` — add `!app/public/sprites/*.png` negation so committed sprites survive.

---

## 2. store.ts — extend the view union (3 edits)

In `app/client/store.ts`:

1. `loadView()` signature + validity check:
   ```ts
   function loadView(): "agents" | "pm" | "game" {
     try {
       const v = localStorage.getItem(VIEW_KEY);
       if (v === "agents" || v === "pm" || v === "game") return v;
     } catch { /* ... */ }
     return "agents";
   }
   ```
2. Signal type:
   ```ts
   const [view, setViewRaw] = createSignal<"agents" | "pm" | "game">(loadView());
   ```
3. `setView` param type:
   ```ts
   export function setView(v: "agents" | "pm" | "game") { ... }
   ```

No other store changes. `sessions`, `selected`, `connected`, `selectSession` are
already exported and used as-is.

---

## 3. main.ts — tab + route (minimal edits)

In `app/client/main.ts`:

1. Add import at top with the other client imports:
   ```ts
   import { GameView } from "./game.ts";
   ```
2. In `TopNav()`, widen the `tab` id type and add the third tab AFTER Projects:
   ```ts
   const tab = (id: "agents" | "pm" | "game", label: string) => html`
     <button class="tab" classList=${() => ({ active: view() === id })}
       onClick=${() => setView(id)}>${label}</button>`;
   return html`
     <nav class="topnav" data-component="TopNav">
       ${tab("agents", "Agents")}
       ${tab("pm", "Projects")}
       ${tab("game", "Game")}
     </nav>`;
   ```
3. In `App()`, add the game branch. Keep it a single ternary chain:
   ```ts
   ${() =>
     view() === "pm"
       ? html`<${PmView} />`
       : view() === "game"
         ? html`<${GameView} />`
         : html`<div class="app"><${Sidebar} /><${Conversation} /></div>`}
   ```

That is the entirety of main.ts changes — keep them this small.

---

## 4. app/client/game.ts — the GameView component + canvas engine

This is the heart of the feature. It exports a single component `GameView` built
with `solid-js/html`. It owns a `<canvas>`, a `requestAnimationFrame` loop, a set
of entity objects, the sprite image cache, and a HUD overlay.

### 4.1 Imports
```ts
import html from "solid-js/html";
import { createEffect, onCleanup, onMount } from "solid-js";
import { sessions, selectSession, selected, connected, setView } from "./store.ts";
import type { SessionSnapshot, SubAgentNode } from "../types.ts";
```

### 4.2 Reactive data capture (critical pattern)
The canvas render loop is NOT a Solid render; it is a plain rAF loop. To read the
freshest sessions inside the loop without re-subscribing each frame, capture them
into a mutable ref via a `createEffect`:
```ts
let liveSessions: SessionSnapshot[] = [];
createEffect(() => { liveSessions = sessions(); }); // re-runs whenever sessions change
```
The loop reads `liveSessions` each frame. (Do NOT call `sessions()` inside rAF — it
would create reactive reads outside a tracking scope; harmless but noisy. The
captured ref is cleaner and decouples render rate from reactivity.)

### 4.3 Sprite manifest + image loading
Load `manifest.json` once on mount and lazily load each sheet PNG:
```ts
type SheetDef = {
  id: string;          // "knight", "mage", ...
  file: string;        // "/sprites/knight.png"
  frameW: number; frameH: number;   // size of ONE frame in the sheet
  frames: number;      // walk-cycle frames in the strip (e.g. 4 or 6)
  cols: number;        // frames per row in the sheet (usually === frames)
};
type Manifest = { sheets: SheetDef[] };
```
Maintain `const images = new Map<string, HTMLImageElement>()` and a
`const loaded = new Map<string, boolean>()`. On `manifest.json` fetch success,
kick off `new Image()` loads for each sheet; on `img.onload` mark loaded. The render
loop checks `loaded.get(sheet.id)` — if false (or manifest fetch failed), it falls
back to procedural drawing (section 5). This guarantees the feature never hard-fails.

Manifest fetch is best-effort:
```ts
fetch("/sprites/manifest.json").then(r => r.ok ? r.json() : null)
  .then((m: Manifest | null) => { if (m) initSheets(m); })
  .catch(() => { /* procedural fallback only */ });
```

### 4.4 Deterministic sprite assignment
Hash a session/sub-agent id to a sheet index so the same agent always gets the
same character across reloads and across clients:
```ts
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function sheetForId(id: string, sheets: SheetDef[]): SheetDef | null {
  if (!sheets.length) return null;
  return sheets[hashStr(id) % sheets.length];
}
// Procedural color fallback uses the same hash -> HSL palette.
function colorForId(id: string): string { return `hsl(${hashStr(id) % 360} 70% 60%)`; }
```

### 4.5 Entity model
One `Entity` per visible agent. Sessions are full-size; sub-agents are smaller
"companions". Maintain `const entities = new Map<string, Entity>()` keyed by a
stable entity id (`"s:" + session.id` for sessions, `"sub:" + session.id + ":" + node.key`
for sub-agents — sub-agent `key` is only unique within a session).
```ts
type EntityKind = "session" | "sub";
interface Entity {
  id: string;            // map key
  kind: EntityKind;
  refId: string;         // session.id (for click-to-open)
  label: string;         // name tag text
  sheet: SheetDef | null;
  color: string;         // procedural fallback color
  scale: number;         // 1 for sessions, ~0.6 for sub-agents
  x: number; y: number;  // position (px, world == canvas space)
  vx: number; vy: number;// velocity
  facing: 1 | -1;        // sprite flip (1 = right)
  // animation
  animFrame: number;     // current walk frame index
  animClock: number;     // ms accumulator
  // behavior
  status: string;        // mirror of live status, refreshed each sync
  busy: boolean;
  state: "walk" | "idle" | "celebrate" | "error"; // derived behavior
  wanderTimer: number;   // ms until next heading change
  spawnT: number;        // 0..1 spawn-in animation progress
  doneFade: number;      // 0..1 fade-out once removed from live data
  bob: number;           // idle bob phase
}
```

### 4.6 Status -> behavior / color mapping
Compute per entity each sync:
- `starting` / `spawning`: state `idle`, slow pulse, dim; small spawn-in pop (`spawnT`).
- `running`: state `walk`; active wander; full brightness; faster walk-cycle.
  If `busy`, add a small "!" or speech-bubble dot and slightly faster steps.
- `idle` (session) / running-but-not-busy: state `idle`; gentle bob, occasional
  short stroll; medium brightness.
- `done`: state `celebrate` for ~1.2s (little hop), then begin `doneFade` -> remove.
  Tint toward green (`--accent`-ish / `#5fd38b`).
- `error`: state `error`; sprite shakes, tinted red (`#e0556b`), stands still.

Color/tint applied to procedural sprites directly; for image sprites, draw the
frame then overlay a low-alpha `globalCompositeOperation="source-atop"` rect for
the status tint (skip tint for the neutral `running`/`idle` states to keep art crisp).

### 4.7 Sync entities from live data
A `syncEntities()` function reconciles `entities` against `liveSessions`. Call it
from a `createEffect` (so it runs on every sessions change) AND once per ~250ms in
the loop as a cheap safety net is NOT needed — the effect is enough. Logic:
```
const seen = new Set<string>();
for (const s of liveSessions) {
  upsert session entity ("s:"+s.id): refresh label/status/busy/sheet;
  if new, spawn at random position with spawnT=0;
  seen.add(eid);
  for (const node of s.subAgents) {
    if (node.status === "done" || "error") still show briefly then fade;
    upsert sub entity ("sub:"+s.id+":"+node.key): scale 0.6, status=node.status;
    seen.add(subEid);
  }
}
// Entities not seen this sync: mark for fade-out (doneFade ramps to 1 then delete),
// EXCEPT keep sessions whose status is "done"/"error" visible until their
// celebrate/fade completes, then drop.
```
Removal is graceful: set a `fadingOut` flag; the loop decrements presence and
deletes the entity when fully faded. This prevents popping when the server prunes
closed sessions.

### 4.8 Physics / wander behavior
Per frame (`dt` ms):
- `wanderTimer -= dt`. When <= 0 and state is `walk`: pick a new random heading
  (angle), set `vx/vy` to `speed * cos/sin` (speed ~ 18-34 px/s, faster when busy),
  reset `wanderTimer` to 800-2200ms. `idle` entities mostly stand; with ~20% chance
  pick a short stroll.
- Integrate position: `x += vx*dt/1000; y += vy*dt/1000`.
- Soft-bounce off arena bounds (with sprite half-size + nameTag margin): invert the
  relevant velocity component and clamp inside.
- `facing = vx >= 0 ? 1 : -1` (only update when moving meaningfully).
- Sub-agents "follow" their parent session loosely: add a weak steering force
  toward the parent entity position (spring with low stiffness) so companions orbit
  near their session. If parent missing, free-wander.
- `error`: zero velocity; add `x += sin(t*40)*1.5` shake in the draw step only.
- `celebrate`: zero horizontal velocity; vertical hop via `bob = abs(sin(t*8))*8`.

### 4.9 Walk-cycle animation timing
- Only advance frames when the entity is actually moving (`walk` with speed>3) or
  always cycle slowly for `idle` (use frames 0..1 as a subtle idle sway, or hold
  frame 0). Frame duration ~120ms at normal speed, ~90ms when busy.
- `animClock += dt; while (animClock >= frameMs) { animClock -= frameMs;
  animFrame = (animFrame + 1) % sheet.frames; }`
- For procedural sprites, the "frame" toggles leg position (see section 5).

### 4.10 Drawing each entity
Order: shadow -> sprite (image OR procedural) -> status FX -> name tag -> sub-agent
link line (optional). Use integer pixel positions (`Math.round`) and
`ctx.imageSmoothingEnabled = false` for crisp pixel-art.

Image sprite draw:
```ts
const sx = (e.animFrame % sheet.cols) * sheet.frameW;
const sy = 0; // single-row strip
const dw = sheet.frameW * e.scale * PIXEL_SCALE;   // PIXEL_SCALE ~ 2-3 to upscale
const dh = sheet.frameH * e.scale * PIXEL_SCALE;
ctx.save();
ctx.translate(Math.round(e.x), Math.round(e.y));
if (e.facing === -1) ctx.scale(-1, 1);
ctx.globalAlpha = entityAlpha(e);            // spawnT / doneFade
ctx.drawImage(img, sx, sy, sheet.frameW, sheet.frameH, -dw/2, -dh, dw, dh);
// status tint overlay (source-atop) if status is error/done
ctx.restore();
```

Shadow: a squished translucent ellipse under the feet (`ctx.ellipse`,
`fillStyle="rgba(0,0,0,.35)"`), squashed during hops.

Name tag (above sprite): a small rounded rect with the label + a status dot.
Draw with the canvas (no DOM) so it tracks the sprite exactly:
```ts
drawTag(ctx, e.x, e.y - dh - 6, e.label, statusDotColor(e.status));
```
Tag background `rgba(20,24,33,.85)` (matches `--panel`), text `#e6e9f0`, font
`10px ui-monospace`. Truncate label to ~16 chars.

Sub-agent link (optional, delightful): a faint dotted line from each sub entity to
its parent session entity (`ctx.setLineDash([2,3])`, low alpha) so the lineage reads
visually.

### 4.11 HUD overlay
Render a DOM HUD on top of the canvas (absolutely positioned), driven reactively by
Solid — this is cheaper and crisper than canvas text for stats. It shows:
- connection state (reuse the `connected()` dot pattern from Sidebar),
- counts: total sessions, running, idle, error, total sub-agents,
- a legend mapping status -> color,
- a small hint: "click a character to open its conversation".
Because HUD is DOM + Solid, it updates automatically from `sessions()`.

### 4.12 Click-to-open interaction
Add a `click` listener on the canvas. Convert click coords to canvas space
(account for `devicePixelRatio` scaling), hit-test entities (nearest within a
radius of its draw box). On hit:
```ts
selectSession(entity.refId);
setView("agents");
```
(Opening the conversation reuses existing routing.) Use a captured snapshot of
entity positions for hit-testing (the `entities` map is fine to read directly).

### 4.13 Canvas sizing / DPR
- The component root is `<div class="game-wrap">` with the `<canvas class="game-canvas">`
  and the HUD inside. CSS makes `.game-wrap` `flex:1; min-height:0; position:relative`.
- On mount and on `resize` (ResizeObserver on the wrap), set:
  ```ts
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS px
  ctx.imageSmoothingEnabled = false;
  ```
  Keep an `arenaW/arenaH` in CSS px for physics bounds.

### 4.14 rAF loop + cleanup (REQUIRED)
```ts
let raf = 0;
let last = performance.now();
const tick = (now: number) => {
  const dt = Math.min(now - last, 50); // clamp big gaps (tab was backgrounded)
  last = now;
  update(dt);     // wander, physics, animation, fades
  draw();         // clear + draw all entities + arena bg
  raf = requestAnimationFrame(tick);
};
onMount(() => { setupCanvas(); raf = requestAnimationFrame(tick); });
onCleanup(() => { cancelAnimationFrame(raf); resizeObserver?.disconnect();
                  canvas.removeEventListener("click", onClick); });
```
The arena background: a dark gradient/grid (subtle dotted grid in `--border` at low
alpha) over `--bg`, drawn fresh each frame after `clearRect`.

### 4.15 Component skeleton (shape, abbreviated)
```ts
export function GameView() {
  let canvas!: HTMLCanvasElement;
  let wrap!: HTMLDivElement;
  // ... refs, maps, state declared in closure ...
  createEffect(() => { liveSessions = sessions(); syncEntities(); });
  onMount(() => { /* setup canvas, observer, manifest fetch, start rAF */ });
  onCleanup(() => { /* cancel rAF, disconnect observer, remove listeners */ });
  return html`
    <div class="game-wrap" data-component="GameView" ref=${(el:HTMLDivElement)=>(wrap=el)}>
      <canvas class="game-canvas" ref=${(el:HTMLCanvasElement)=>(canvas=el)}></canvas>
      <div class="game-hud">${/* reactive Solid HUD reading sessions()/connected() */}</div>
    </div>`;
}
```

---

## 5. Procedural fallback sprite (robustness)

If `manifest.json` is missing OR a sheet PNG fails to load, draw a simple but
charming procedural pixel character entirely on the canvas, so the feature works
with zero assets. Design:
- A ~12x16 "pixel doll": head (skin tone), body (the entity's `colorForId`),
  two legs that alternate position based on `animFrame % 2` (walk illusion), two
  eyes (2 dark pixels), and a 1px outline. Draw with `ctx.fillRect` blocks scaled by
  `PIXEL` (e.g. 3px per logical pixel).
- Sub-agents: same doll at `scale 0.6` and a slightly desaturated color.
- Status reflected by tint/FX identical to section 4.6 (red shake for error, green
  hop for done, dim for starting).
- Keep a single `drawProcedural(ctx, e, frame)` function so image and procedural
  paths share the same update/animation logic — only the draw differs.

This path is also useful during development before sprites are generated.

---

## 6. Sprite generation script — scripts/gen-sprites.ts

A standalone Bun script (NOT part of the server) that calls the Gemini image API and
writes committed PNG sheets + a manifest. Run manually:
`bun run scripts/gen-sprites.ts` (optionally with flags below).

### 6.1 Credentials
Read `~/.env_ai` directly (the app's `env.ts` loads a different file). Parse it the
same way `app/env.ts` does (KEY=VALUE lines, strip quotes), then use
`GEMINI_API_KEY` (fallback `GOOGLE_GENERATIVE_AI_API_KEY`). Fail with a clear
message if absent.

### 6.2 Model + API call shape
Model: `gemini-3-pro-image` (confirmed latest/working). Use the REST generateContent
endpoint with the API key as a query param or `x-goog-api-key` header:
```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent
Header: x-goog-api-key: <key>
Body: {
  "contents": [{ "parts": [{ "text": "<PROMPT>" }] }],
  "generationConfig": { "responseModalities": ["IMAGE"] }
}
```
The response contains an inline image part:
`candidates[0].content.parts[].inlineData { mimeType, data(base64) }`. Decode the
base64, write the bytes. (If the SDK `@google/genai` is preferred, the same call maps
to `ai.models.generateContent({ model, contents, config:{ responseModalities:["Image"] }})`
— but plain fetch avoids adding a dependency; prefer fetch.)

### 6.3 Prompt strategy — clean, sliceable strips
The model returns large images (e.g. 1408x768 or 1024x1024). The robust approach is
to PROMPT for a clean, evenly-spaced horizontal strip on a flat background, then slice
deterministically by frame rectangle. Prompt template per character variant:
```
Pixel-art sprite sheet, side-view, of a <CHARACTER> game character walking.
Produce EXACTLY <N> frames of a left-to-right walk cycle, arranged in a SINGLE
horizontal row, evenly spaced, each frame the same size, all facing RIGHT.
Flat solid magenta background (#FF00FF) with NO gradients, NO shadows on the
background, NO text, NO grid lines, NO numbers. Characters fully contained within
their frame with consistent baseline (feet aligned). Crisp pixel-art, limited
palette, 1px dark outline. Clean and centered.
```
Where `<N>` = 4 (or 6) and `<CHARACTER>` cycles through a small distinct set, e.g.:
`knight in blue armor`, `purple wizard with staff`, `green-hooded ranger`,
`red robot`, `orange fox creature`, `cyan slime`, `yellow bard`, `grey cat ninja`.
4–8 variants is enough.

### 6.4 Slicing / normalization
Even with a "clean strip" prompt the geometry is not guaranteed, so the script
normalizes:
1. Decode the returned image (use Bun's built-in `sharp`-free path: the script may
   use the `sharp` npm dep OR the lightweight approach below). RECOMMENDED: add a
   dev-only image lib. Two acceptable options:
   - Use `@napi-rs/canvas` or `sharp` (add to devDependencies) to load the image,
     detect content columns by scanning for non-background (non-#FF00FF) pixels,
     segment into `N` frame bounding boxes, crop each, trim to a uniform
     `frameW x frameH`, make the magenta background transparent, and composite the
     N frames into ONE tight horizontal strip PNG.
   - Simpler fallback if no lib: trust the model's even spacing — split the image
     into `N` equal-width columns, write the whole image as the sheet, and record
     `frameW = imageWidth / N`, `frameH = imageHeight` in the manifest. The client
     samples by `frameW` rectangle. This requires NO image processing but produces
     slightly looser frames. Start here; upgrade to bbox detection if frames jitter.
2. Background removal: replace pixels within a tolerance of `#FF00FF` with alpha 0
   (only needed if using an image lib; the "simple" path can leave magenta and the
   client can `globalCompositeOperation` it out, but transparent PNGs are cleaner —
   prefer doing it in the script when a lib is available).
3. Downscale: target a frame size around 32–48px tall so the committed assets are
   small; the client upscales with `PIXEL_SCALE` and nearest-neighbor.

### 6.5 Outputs
Write to `app/public/sprites/`:
- `app/public/sprites/<id>.png` — one horizontal strip per character (N frames).
- `app/public/sprites/manifest.json` — `{ "sheets": [ { id, file:"/sprites/<id>.png",
  frameW, frameH, frames, cols } , ... ] }`.
Idempotent: overwrite on re-run. Log each file + final manifest.

### 6.6 Flags (nice-to-have)
- `--only <id>` regenerate a single character.
- `--frames 6` override N.
- `--dry-run` print prompts without calling the API.

---

## 7. server.ts — content types + optional regen endpoint

1. Add to `CONTENT_TYPE`:
   ```ts
   png: "image/png",
   json: "application/json; charset=utf-8",
   ```
   (Static serving already resolves `app/public/sprites/*.png` and `manifest.json`
   by path; this just sets correct headers.)

2. OPTIONAL on-demand regeneration endpoint (guarded, off by default):
   Add before the static-file block in `fetch`:
   ```ts
   if (url.pathname === "/api/sprites/regen" && req.method === "POST") {
     // Spawn the generation script out-of-process so the server stays responsive.
     // Only enable when STRAWIT_ENABLE_SPRITE_REGEN=1 to avoid accidental API spend.
     if (process.env.STRAWIT_ENABLE_SPRITE_REGEN !== "1")
       return new Response(JSON.stringify({ error: "disabled" }), { status: 403 });
     Bun.spawn(["bun", "run", join(ROOT, "..", "scripts", "gen-sprites.ts")], { ... });
     return new Response(JSON.stringify({ started: true }), {
       headers: { "content-type": "application/json" } });
   }
   ```
   The client need not call this for v1; sprites are committed assets. Keep this
   endpoint minimal and feature-flagged.

---

## 8. .gitignore — let committed sprites survive

`.gitignore` has a blanket `*.png`. Add (after the `*.png` line) a negation so the
committed sprites are tracked:
```
# keep generated game sprites (committed assets)
!app/public/sprites/
!app/public/sprites/*.png
```
Verify with `git check-ignore -v app/public/sprites/knight.png` (should report NOT
ignored after the change).

---

## 9. styles.css — game styles

Append a `/* ---- game ---- */` block:
```css
.game-wrap { flex: 1; min-height: 0; position: relative; overflow: hidden;
  background: radial-gradient(circle at 50% 30%, #11151f, var(--bg)); }
.game-canvas { position: absolute; inset: 0; width: 100%; height: 100%;
  display: block; image-rendering: pixelated; }
.game-hud { position: absolute; top: 10px; left: 10px; display: flex; flex-direction: column;
  gap: 6px; padding: 8px 10px; background: rgba(20,24,33,.78); border: 1px solid var(--border);
  border-radius: var(--radius); font-size: 11.5px; color: var(--text); pointer-events: none;
  backdrop-filter: blur(3px); }
.game-hud .stat { display: flex; gap: 6px; align-items: center; }
.game-hud .legend { display: flex; gap: 10px; flex-wrap: wrap; color: var(--dim); }
.game-hud .swatch { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
.game-hint { position: absolute; bottom: 8px; right: 12px; color: var(--dim);
  font-size: 11px; pointer-events: none; }
```
`.game-wrap` slots into `.root-shell` (flex column) and fills the content area below
the 38px topnav automatically via `flex:1; min-height:0`.

---

## 10. Implementation order (sequencing)

1. store.ts union edits (3 places). Build still passes.
2. Stub `app/client/game.ts` exporting a minimal `GameView` that draws an empty
   arena. Add tab + route in main.ts. Add styles. -> Tab appears, canvas fills area.
3. Implement procedural sprites + entity model + sync + physics + walk anim + HUD +
   click-to-open. -> Fully working with zero assets (procedural). VERIFY here.
4. Write `scripts/gen-sprites.ts`; generate the 4–8 sheets + manifest into
   `app/public/sprites/`. Fix `.gitignore`. Add `png`/`json` content types in server.
5. Wire image-sprite drawing in game.ts (manifest fetch + image cache + frame slice),
   keeping procedural as fallback. -> Real sprites walk; missing assets degrade
   gracefully.
6. OPTIONAL: regen endpoint (feature-flagged).

Each step keeps the build green and the app runnable.

---

## 11. Verification

- **Build/run**: `bun run app/server.ts` (port 4317). Server prints the URL; if the
  Bun.build of the client fails (e.g. a type/import error in game.ts), it logs and
  throws — a green start means the bundle compiled.
- **Tab placement**: open the app; the top nav shows `Agents | Projects | Game`, in
  that order. Clicking `Game` activates it; reload persists it (localStorage
  `strawit.view` = `"game"`).
- **Animation**: with at least one live session, a sprite walks around; running
  sessions wander actively, idle ones bob, sub-agents appear as smaller companions
  near their parent with a faint link line, name tags float above, the HUD shows
  live counts. With no live sessions the arena is empty but animating (grid pulse).
- **Robustness**: temporarily rename `app/public/sprites/` (or before generating) —
  the view still renders procedural characters with no errors in console.
- **Interaction**: clicking a character opens its conversation (switches to Agents
  with that session selected).
- **Cleanup**: switch away from the Game tab and back repeatedly; no rAF leak
  (the loop is cancelled in `onCleanup`; confirm CPU settles when off-tab).
- **Sprites**: `git check-ignore -v app/public/sprites/<id>.png` reports the file is
  NOT ignored; `manifest.json` lists every sheet with sane `frameW/frameH/frames`.

---

## 12. Critical files for implementation

- /Users/goaman/.goapower/worktrees/strawit/agent-game/app/client/game.ts (new)
- /Users/goaman/.goapower/worktrees/strawit/agent-game/app/client/main.ts (tab + route)
- /Users/goaman/.goapower/worktrees/strawit/agent-game/app/client/store.ts (view union)
- /Users/goaman/.goapower/worktrees/strawit/agent-game/scripts/gen-sprites.ts (new)
- /Users/goaman/.goapower/worktrees/strawit/agent-game/app/public/styles.css (game styles)
