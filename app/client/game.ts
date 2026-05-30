// Game view: a live pixel-art arena where every agent session — and each
// sub-agent — is a little character that walks around. Driven entirely by the
// live `sessions()` signal over the websocket. Authored with solid-js/html
// (no JSX). The canvas render loop is a plain requestAnimationFrame loop that
// reads a captured snapshot of sessions (refreshed by a createEffect), so the
// render rate is decoupled from reactivity. The loop is cancelled in onCleanup.
//
// Robustness: if sprite sheets are missing or fail to load, each character is
// drawn procedurally as a charming little pixel doll, so the feature never
// hard-fails. The image path is a pure enhancement layered on top.

import html from "solid-js/html";
import { createEffect, createMemo, onCleanup, onMount } from "solid-js";
import { connected, selectSession, sessions, setView } from "./store.ts";
import type { SessionSnapshot } from "../types.ts";

// ---- sprite manifest ----
interface SheetDef {
  id: string;
  file: string;
  frameW: number;
  frameH: number;
  frames: number;
  cols: number;
}
interface Manifest {
  sheets: SheetDef[];
}

// ---- deterministic hashing (same agent -> same character / color) ----
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function colorForId(id: string): string {
  return `hsl(${hashStr(id) % 360} 68% 60%)`;
}
// A second, darker shade derived from the same hue (legs / shading).
function shadeForId(id: string): string {
  return `hsl(${hashStr(id) % 360} 55% 42%)`;
}

// ---- status -> colors ----
const STATUS_DOT: Record<string, string> = {
  starting: "#c9a227",
  spawning: "#c9a227",
  running: "#6ea8fe",
  idle: "#8b93a7",
  done: "#5fd38b",
  error: "#e0556b",
};
function statusDot(status: string): string {
  return STATUS_DOT[status] ?? "#8b93a7";
}

// ---- entity model ----
type EntityKind = "session" | "sub";
type Behavior = "walk" | "idle" | "celebrate" | "error";

interface Entity {
  id: string; // map key
  kind: EntityKind;
  refId: string; // session.id (for click-to-open)
  parentId: string | null; // entity id of parent session (sub-agents)
  label: string;
  color: string;
  shade: string;
  sheetId: string | null; // assigned sheet id (resolved lazily)
  scale: number; // 1 sessions, ~0.62 sub-agents
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: 1 | -1;
  animFrame: number;
  animClock: number;
  status: string;
  busy: boolean;
  state: Behavior;
  wanderTimer: number;
  spawnT: number; // 0..1 spawn-in pop
  celebrateT: number; // ms remaining of celebrate hop
  fadingOut: boolean;
  presence: number; // 1 present, ramps to 0 then deleted
  bob: number; // idle bob phase accumulator
  shake: number; // error shake phase accumulator
}

// logical pixel doll dims (procedural fallback), scaled up by PIXEL.
const PIXEL = 3;
const DOLL_W = 12;
const DOLL_H = 16;

export function GameView() {
  let canvas!: HTMLCanvasElement;
  let wrap!: HTMLDivElement;
  let ctx: CanvasRenderingContext2D | null = null;

  // Live data captured from the signal (read inside rAF without re-subscribing).
  let liveSessions: SessionSnapshot[] = [];

  // Detected per-sheet frame geometry (overrides the manifest after the image is
  // processed). The Gemini-generated strips vary a lot — clean single rows, rows
  // with frame borders, white backgrounds, even 2-row grids — so rather than
  // trust the manifest's guessed geometry we measure the real content of each
  // processed (background-keyed) sheet and slice on that.
  interface Geom {
    sx0: number; // left edge of content region (px)
    sy0: number; // top edge of content region (px)
    frameW: number; // width of one frame within the content region
    frameH: number; // height of one frame within the content region
    cols: number; // frames per row
    rows: number; // number of rows of frames
  }

  // Sprite assets.
  const sheets: SheetDef[] = [];
  const sheetById = new Map<string, SheetDef>();
  const images = new Map<string, HTMLImageElement>(); // raw loaded image
  const keyed = new Map<string, HTMLCanvasElement>(); // background -> transparent
  const geom = new Map<string, Geom>(); // detected frame geometry per sheet
  const loaded = new Map<string, boolean>();

  // Entities.
  const entities = new Map<string, Entity>();

  // Arena bounds (CSS px).
  let arenaW = 800;
  let arenaH = 600;

  let raf = 0;
  let last = performance.now();
  let resizeObserver: ResizeObserver | null = null;
  let elapsed = 0; // ms since mount (drives oscillators)

  // ---- sprite sheet assignment + color-keying ----
  function sheetForEntity(e: Entity): SheetDef | null {
    if (!sheets.length) return null;
    if (e.sheetId && sheetById.has(e.sheetId)) return sheetById.get(e.sheetId)!;
    const sd = sheets[hashStr(e.id) % sheets.length];
    e.sheetId = sd.id;
    return sd;
  }

  // Process a loaded sheet: key the background out to transparent, then measure
  // the real content geometry (rows/cols/frame box). The generated strips vary
  // wildly (magenta vs white backgrounds, with/without frame borders, 1 vs 2
  // rows), so we (a) always key pure magenta, (b) also key whatever flat colour
  // dominates the image corners (covers white-bg sheets), and (c) derive the
  // frame box from the bounding box of the remaining opaque content. If anything
  // fails or looks degenerate we leave the manifest geometry in place and draw
  // the raw image — the procedural path still guarantees something renders.
  function processSheet(sd: SheetDef, img: HTMLImageElement) {
    try {
      const W = img.naturalWidth;
      const H = img.naturalHeight;
      if (!W || !H) return;
      const off = document.createElement("canvas");
      off.width = W;
      off.height = H;
      const octx = off.getContext("2d", { willReadFrequently: true });
      if (!octx) return;
      octx.imageSmoothingEnabled = false;
      octx.drawImage(img, 0, 0);
      const data = octx.getImageData(0, 0, W, H);
      const px = data.data;

      // Background colour = the most common of the four corner pixels.
      const corners = [
        [0, 0],
        [W - 1, 0],
        [0, H - 1],
        [W - 1, H - 1],
      ];
      const sample = corners.map(([cx, cy]) => {
        const o = (cy * W + cx) * 4;
        return [px[o], px[o + 1], px[o + 2]];
      });
      const bg = sample[0]; // top-left is reliably background in all variants

      const isBg = (r: number, g: number, b: number) => {
        // pure-magenta key (the prompted background)
        if (r > 200 && g < 70 && b > 200) return true;
        // flat corner-background key (e.g. white-bg sheets)
        const d = Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]);
        return d < 36;
      };

      for (let i = 0; i < px.length; i += 4) {
        if (isBg(px[i], px[i + 1], px[i + 2])) px[i + 3] = 0;
      }
      octx.putImageData(data, 0, 0);
      keyed.set(sd.id, off);

      // ---- geometry detection on the keyed alpha channel ----
      // Column occupancy: which x columns contain any opaque pixel.
      const colHas = new Uint8Array(W);
      const rowHas = new Uint8Array(H);
      const MIN_A = 24;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (px[(y * W + x) * 4 + 3] > MIN_A) {
            colHas[x] = 1;
            rowHas[y] = 1;
          }
        }
      }
      // Content vertical extent + split into rows by gaps taller than a threshold.
      const rowBands = bandsFrom(rowHas, Math.max(6, Math.floor(H * 0.04)));
      const colBands = bandsFrom(colHas, Math.max(4, Math.floor(W * 0.01)));
      if (!rowBands.length || !colBands.length) return; // empty — keep manifest

      // Pick the row band that best matches `cols` content columns. If a single
      // row spans most of the width assume the strip is one row of `frames`.
      const rows = rowBands.length >= 2 && rowBands.length <= 3 ? rowBands.length : 1;
      const top = rowBands[0].start;
      const bottom = rowBands[rowBands.length - 1].end;
      const sx0 = colBands[0].start;
      const right = colBands[colBands.length - 1].end;
      const contentW = Math.max(1, right - sx0);
      const contentH = Math.max(1, bottom - top);
      const cols = Math.max(1, Math.round(sd.frames / rows));
      geom.set(sd.id, {
        sx0,
        sy0: top,
        frameW: Math.floor(contentW / cols),
        frameH: Math.floor(contentH / rows),
        cols,
        rows,
      });
    } catch {
      /* tainted canvas / cross-origin / decode issue — keep manifest geometry */
    }
  }

  // Collapse a 0/1 occupancy array into contiguous "bands" of set pixels,
  // merging runs separated by gaps smaller than `minGap`.
  function bandsFrom(occ: Uint8Array, minGap: number): { start: number; end: number }[] {
    const bands: { start: number; end: number }[] = [];
    let i = 0;
    const n = occ.length;
    while (i < n) {
      while (i < n && !occ[i]) i++;
      if (i >= n) break;
      let start = i;
      while (i < n && occ[i]) i++;
      let end = i; // exclusive
      // merge with previous band if the gap is small
      if (bands.length && start - bands[bands.length - 1].end < minGap) {
        bands[bands.length - 1].end = end;
      } else {
        bands.push({ start, end });
      }
    }
    return bands;
  }

  function initSheets(m: Manifest) {
    if (!m || !Array.isArray(m.sheets)) return;
    for (const sd of m.sheets) {
      if (!sd || !sd.id || !sd.file || !sd.frames) continue;
      sheets.push(sd);
      sheetById.set(sd.id, sd);
      loaded.set(sd.id, false);
      const img = new Image();
      img.onload = () => {
        images.set(sd.id, img);
        processSheet(sd, img);
        loaded.set(sd.id, true);
      };
      img.onerror = () => loaded.set(sd.id, false);
      img.src = sd.file;
    }
  }

  // ---- reconcile entities against live sessions ----
  function spawnPos(): { x: number; y: number } {
    const m = 60;
    return {
      x: m + Math.random() * Math.max(1, arenaW - m * 2),
      y: m + Math.random() * Math.max(1, arenaH - m * 2),
    };
  }

  function upsertSession(s: SessionSnapshot, seen: Set<string>) {
    const eid = "s:" + s.id;
    seen.add(eid);
    let e = entities.get(eid);
    if (!e) {
      const p = spawnPos();
      e = {
        id: eid,
        kind: "session",
        refId: s.id,
        parentId: null,
        label: s.label,
        color: colorForId(s.id),
        shade: shadeForId(s.id),
        sheetId: null,
        scale: 1,
        x: p.x,
        y: p.y,
        vx: 0,
        vy: 0,
        facing: 1,
        animFrame: 0,
        animClock: 0,
        status: s.status,
        busy: s.busy,
        state: "idle",
        wanderTimer: Math.random() * 1200,
        spawnT: 0,
        celebrateT: 0,
        fadingOut: false,
        presence: 1,
        bob: Math.random() * Math.PI * 2,
        shake: 0,
      };
      entities.set(eid, e);
    }
    e.label = s.label;
    e.fadingOut = false;
    refreshStatus(e, s.status, s.busy);

    for (const node of s.subAgents) {
      const subEid = "sub:" + s.id + ":" + node.key;
      seen.add(subEid);
      let se = entities.get(subEid);
      if (!se) {
        // spawn near the parent so companions read as belonging to it.
        const px = e.x + (Math.random() - 0.5) * 50;
        const py = e.y + (Math.random() - 0.5) * 50;
        se = {
          id: subEid,
          kind: "sub",
          refId: s.id,
          parentId: eid,
          label: shortPrompt(node.prompt) || ("L" + node.depth),
          color: colorForId(subEid),
          shade: shadeForId(subEid),
          sheetId: null,
          scale: 0.62,
          x: px,
          y: py,
          vx: 0,
          vy: 0,
          facing: 1,
          animFrame: 0,
          animClock: 0,
          status: node.status,
          busy: node.status === "running",
          state: "idle",
          wanderTimer: Math.random() * 1000,
          spawnT: 0,
          celebrateT: 0,
          fadingOut: false,
          presence: 1,
          bob: Math.random() * Math.PI * 2,
          shake: 0,
        };
        entities.set(subEid, se);
      }
      se.parentId = eid;
      se.label = shortPrompt(node.prompt) || ("L" + node.depth);
      se.fadingOut = false;
      refreshStatus(se, node.status, node.status === "running");
    }
  }

  function shortPrompt(p: string): string {
    if (!p) return "";
    const one = p.replace(/\s+/g, " ").trim();
    return one.length > 18 ? one.slice(0, 17) + "…" : one;
  }

  function refreshStatus(e: Entity, status: string, busy: boolean) {
    const prev = e.status;
    e.status = status;
    e.busy = busy;
    if (status === "starting" || status === "spawning") {
      e.state = "idle";
    } else if (status === "error") {
      e.state = "error";
    } else if (status === "done") {
      // kick off a celebration on the transition into done.
      if (prev !== "done") e.celebrateT = 1200;
      e.state = e.celebrateT > 0 ? "celebrate" : "idle";
    } else if (status === "running") {
      e.state = "walk";
    } else {
      // idle session: gentle bob, occasional stroll.
      e.state = "idle";
    }
  }

  function syncEntities() {
    const seen = new Set<string>();
    for (const s of liveSessions) upsertSession(s, seen);
    // Anything not seen this pass begins fading out (graceful, no pop).
    for (const e of entities.values()) {
      if (!seen.has(e.id)) e.fadingOut = true;
    }
  }

  // ---- per-frame update ----
  function update(dt: number) {
    const dts = dt / 1000;
    elapsed += dt;
    const toDelete: string[] = [];

    for (const e of entities.values()) {
      // spawn-in pop
      if (e.spawnT < 1) e.spawnT = Math.min(1, e.spawnT + dts * 3);

      // celebrate countdown
      if (e.celebrateT > 0) {
        e.celebrateT -= dt;
        e.state = "celebrate";
        if (e.celebrateT <= 0 && e.status === "done") e.state = "idle";
      }

      // fade-out / presence
      if (e.fadingOut) {
        e.presence -= dts * 1.4;
        if (e.presence <= 0) {
          toDelete.push(e.id);
          continue;
        }
      } else if (e.presence < 1) {
        e.presence = Math.min(1, e.presence + dts * 2);
      }

      // ---- behavior / physics ----
      const speedBase = e.busy ? 30 : 22;
      if (e.state === "walk") {
        e.wanderTimer -= dt;
        if (e.wanderTimer <= 0) {
          const ang = Math.random() * Math.PI * 2;
          const sp = speedBase + Math.random() * 12;
          e.vx = Math.cos(ang) * sp;
          e.vy = Math.sin(ang) * sp;
          e.wanderTimer = 800 + Math.random() * 1400;
        }
      } else if (e.state === "idle") {
        e.wanderTimer -= dt;
        if (e.wanderTimer <= 0) {
          // ~20% chance to take a short stroll, else stand still.
          if (Math.random() < 0.22) {
            const ang = Math.random() * Math.PI * 2;
            const sp = 14 + Math.random() * 8;
            e.vx = Math.cos(ang) * sp;
            e.vy = Math.sin(ang) * sp;
            e.wanderTimer = 500 + Math.random() * 700;
          } else {
            e.vx = 0;
            e.vy = 0;
            e.wanderTimer = 700 + Math.random() * 1500;
          }
        }
      } else {
        // error / celebrate: stand in place
        e.vx = 0;
        e.vy = 0;
      }

      // sub-agents loosely orbit their parent (weak spring steering).
      if (e.kind === "sub" && e.parentId) {
        const p = entities.get(e.parentId);
        if (p) {
          const dx = p.x - e.x;
          const dy = p.y - e.y;
          const dist = Math.hypot(dx, dy) || 1;
          if (dist > 70) {
            const k = 26;
            e.vx += (dx / dist) * k * dts;
            e.vy += (dy / dist) * k * dts;
          }
        }
      }

      // integrate
      e.x += e.vx * dts;
      e.y += e.vy * dts;

      // soft bounce off bounds
      const half = (DOLL_W * PIXEL * e.scale) / 2 + 6;
      const top = DOLL_H * PIXEL * e.scale + 18; // leave room for name tag
      if (e.x < half) {
        e.x = half;
        e.vx = Math.abs(e.vx);
      } else if (e.x > arenaW - half) {
        e.x = arenaW - half;
        e.vx = -Math.abs(e.vx);
      }
      if (e.y < top) {
        e.y = top;
        e.vy = Math.abs(e.vy);
      } else if (e.y > arenaH - 8) {
        e.y = arenaH - 8;
        e.vy = -Math.abs(e.vy);
      }

      // facing follows horizontal motion
      if (Math.abs(e.vx) > 4) e.facing = e.vx >= 0 ? 1 : -1;

      // oscillators
      e.bob += dts * (e.state === "idle" ? 3 : 5);
      if (e.state === "error") e.shake += dt * 0.04;

      // walk-cycle animation: advance frames while moving, else hold/sway.
      const sd = sheetForEntity(e);
      const g = sd ? geom.get(sd.id) : undefined;
      const frames = g ? g.cols * g.rows : sd ? sd.frames : 2;
      const moving = Math.hypot(e.vx, e.vy) > 3;
      if (moving) {
        const frameMs = e.busy ? 90 : 120;
        e.animClock += dt;
        while (e.animClock >= frameMs) {
          e.animClock -= frameMs;
          e.animFrame = (e.animFrame + 1) % frames;
        }
      } else {
        e.animFrame = 0;
        e.animClock = 0;
      }
    }

    for (const id of toDelete) entities.delete(id);
  }

  // ---- drawing ----
  function entityAlpha(e: Entity): number {
    return Math.max(0, Math.min(1, e.spawnT * e.presence));
  }

  function hopOffset(e: Entity): number {
    if (e.state === "celebrate") return Math.abs(Math.sin(elapsed * 0.012)) * 10;
    if (e.state === "idle") return Math.sin(e.bob) * 1.5;
    return 0;
  }

  function draw() {
    if (!ctx) return;
    const c = ctx;
    c.clearRect(0, 0, arenaW, arenaH);
    c.imageSmoothingEnabled = false;

    drawArenaBg(c);

    // sub-agent link lines first (under sprites)
    c.save();
    c.setLineDash([2, 3]);
    for (const e of entities.values()) {
      if (e.kind !== "sub" || !e.parentId) continue;
      const p = entities.get(e.parentId);
      if (!p) continue;
      c.globalAlpha = 0.18 * entityAlpha(e);
      c.strokeStyle = "#6ea8fe";
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(Math.round(e.x), Math.round(e.y));
      c.lineTo(Math.round(p.x), Math.round(p.y));
      c.stroke();
    }
    c.restore();
    c.setLineDash([]);

    // sprites, sorted by y so nearer ones overlap correctly
    const list = [...entities.values()].sort((a, b) => a.y - b.y);
    for (const e of list) drawEntity(c, e);
  }

  function drawArenaBg(c: CanvasRenderingContext2D) {
    // subtle pulsing dotted grid in --border at low alpha
    const step = 32;
    const pulse = 0.5 + 0.5 * Math.sin(elapsed * 0.0008);
    c.save();
    c.fillStyle = "#262d3d";
    c.globalAlpha = 0.18 + pulse * 0.06;
    for (let x = step / 2; x < arenaW; x += step) {
      for (let y = step / 2; y < arenaH; y += step) {
        c.fillRect(Math.round(x), Math.round(y), 1, 1);
      }
    }
    c.restore();
  }

  function drawEntity(c: CanvasRenderingContext2D, e: Entity) {
    const alpha = entityAlpha(e);
    if (alpha <= 0.01) return;
    const hop = hopOffset(e);
    let x = e.x;
    if (e.state === "error") x += Math.sin(e.shake) * 1.6; // shake

    const sd = sheetForEntity(e);
    const usingImage = sd && loaded.get(sd.id);

    // dimming for starting/spawning
    const dim = e.status === "starting" || e.status === "spawning" ? 0.62 : 1;

    // shadow under feet (squashed during hop)
    const footY = e.y;
    const imgSize = usingImage ? spriteSize(sd!, e.scale) : null;
    const shW = (imgSize ? imgSize.w : DOLL_W * PIXEL * e.scale) * 0.55;
    c.save();
    c.globalAlpha = alpha * 0.32 * (1 - Math.min(hop / 14, 0.6));
    c.fillStyle = "#000";
    c.beginPath();
    c.ellipse(Math.round(x), Math.round(footY), shW, shW * 0.32, 0, 0, Math.PI * 2);
    c.fill();
    c.restore();

    c.save();
    c.globalAlpha = alpha * dim;
    c.translate(Math.round(x), Math.round(footY - hop));
    if (e.facing === -1) c.scale(-1, 1);

    if (usingImage) {
      drawImageSprite(c, e, sd!);
    } else {
      drawProcedural(c, e);
    }
    c.restore();

    // status tint overlay (kept subtle; skip neutral states)
    // applied above inside draw functions via tint param for procedural; for
    // image sprites we overlay here using source-atop within the same transform.

    // name tag (drawn in screen space, not flipped)
    const spriteH = imgSize ? imgSize.h : DOLL_H * PIXEL * e.scale;
    drawTag(c, x, footY - hop - spriteH - 6, e.label, statusDot(e.status), alpha);

    // busy speech dot
    if (e.busy && e.status === "running") {
      c.save();
      c.globalAlpha = alpha * (0.5 + 0.5 * Math.sin(elapsed * 0.012));
      c.fillStyle = "#6ea8fe";
      c.beginPath();
      c.arc(Math.round(x + shW * 0.7), Math.round(footY - hop - spriteH - 2), 2.5, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
  }

  function tintColor(e: Entity): string | null {
    if (e.status === "error") return "rgba(224,85,107,0.45)";
    if (e.status === "done") return "rgba(95,211,139,0.40)";
    return null;
  }

  // Resolve the source frame rectangle for an entity's current animation frame,
  // preferring detected geometry (handles multi-row grids + content offsets) and
  // falling back to the manifest's single-row assumption.
  function frameRect(sd: SheetDef, frame: number): { sx: number; sy: number; sw: number; sh: number } {
    const g = geom.get(sd.id);
    if (g) {
      const f = frame % (g.cols * g.rows);
      const col = f % g.cols;
      const row = Math.floor(f / g.cols);
      return {
        sx: g.sx0 + col * g.frameW,
        sy: g.sy0 + row * g.frameH,
        sw: g.frameW,
        sh: g.frameH,
      };
    }
    return { sx: (frame % sd.cols) * sd.frameW, sy: 0, sw: sd.frameW, sh: sd.frameH };
  }

  // Display size (CSS px) of one frame, from detected geometry when available.
  function spriteSize(sd: SheetDef, scale: number): { w: number; h: number } {
    const g = geom.get(sd.id);
    const fw = g ? g.frameW : sd.frameW;
    const fh = g ? g.frameH : sd.frameH;
    // Normalise so a frame is ~46px tall on screen regardless of source res.
    const k = (46 / Math.max(1, fh)) * scale;
    return { w: fw * k, h: fh * k };
  }

  function drawImageSprite(c: CanvasRenderingContext2D, e: Entity, sd: SheetDef) {
    const src = keyed.get(sd.id) ?? images.get(sd.id);
    if (!src) {
      drawProcedural(c, e);
      return;
    }
    const { sx, sy, sw, sh } = frameRect(sd, e.animFrame);
    const { w: dw, h: dh } = spriteSize(sd, e.scale);
    c.drawImage(src as CanvasImageSource, sx, sy, sw, sh, -dw / 2, -dh, dw, dh);
    // status tint via source-atop (only paints over the drawn sprite pixels)
    const tint = tintColor(e);
    if (tint) {
      c.save();
      c.globalCompositeOperation = "source-atop";
      c.fillStyle = tint;
      c.fillRect(-dw / 2, -dh, dw, dh);
      c.restore();
    }
  }

  // Procedural pixel doll. Drawn with the local transform origin at the feet
  // (0,0 = center-bottom), so it shares positioning with the image path.
  function drawProcedural(c: CanvasRenderingContext2D, e: Entity) {
    const p = PIXEL * e.scale;
    const w = DOLL_W;
    const h = DOLL_H;
    // helper: fill a logical-pixel block (px,py) sized (pw,ph)
    const blk = (px: number, py: number, pw: number, ph: number, color: string) => {
      c.fillStyle = color;
      c.fillRect(Math.round((px - w / 2) * p), Math.round((py - h) * p), Math.ceil(pw * p), Math.ceil(ph * p));
    };

    const tint = tintColor(e);
    const body = e.status === "error" ? "#e0556b" : e.status === "done" ? "#5fd38b" : e.color;
    const legShade = e.status === "error" ? "#b03b4d" : e.status === "done" ? "#3fa566" : e.shade;
    const outline = "#11131a";
    const skin = "#f1c6a0";

    // outline pass (a 1px dark silhouette behind everything)
    blk(2, 2, 8, 12, outline);

    // head
    blk(3, 2, 6, 4, skin);
    // eyes (2 dark pixels) — face right
    blk(6, 3, 1, 1, "#1b1f2b");
    blk(7, 3, 1, 1, "#1b1f2b");

    // body
    blk(3, 6, 6, 6, body);
    // little highlight stripe
    blk(4, 7, 1, 4, "rgba(255,255,255,0.18)");

    // legs alternate by frame (walk illusion)
    const phase = e.animFrame % 2;
    if (phase === 0) {
      blk(3, 12, 2, 4, legShade);
      blk(7, 12, 2, 3, legShade);
    } else {
      blk(3, 12, 2, 3, legShade);
      blk(7, 12, 2, 4, legShade);
    }

    // status tint overlay over the doll
    if (tint) {
      c.save();
      c.globalCompositeOperation = "source-atop";
      c.fillStyle = tint;
      c.fillRect(Math.round((-w / 2) * p), Math.round((-h) * p), Math.ceil(w * p), Math.ceil(h * p));
      c.restore();
    }
  }

  function drawTag(
    c: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    label: string,
    dot: string,
    alpha: number,
  ) {
    const text = label.length > 16 ? label.slice(0, 15) + "…" : label;
    c.save();
    c.globalAlpha = alpha;
    c.font = "10px ui-monospace, monospace";
    c.textBaseline = "middle";
    const tw = c.measureText(text).width;
    const padX = 5;
    const dotW = 8;
    const boxW = tw + padX * 2 + dotW;
    const boxH = 14;
    const bx = Math.round(cx - boxW / 2);
    const by = Math.round(cy - boxH / 2);
    // rounded rect bg
    c.fillStyle = "rgba(20,24,33,0.85)";
    roundRect(c, bx, by, boxW, boxH, 3);
    c.fill();
    c.strokeStyle = "rgba(38,45,61,0.9)";
    c.lineWidth = 1;
    roundRect(c, bx + 0.5, by + 0.5, boxW - 1, boxH - 1, 3);
    c.stroke();
    // status dot
    c.fillStyle = dot;
    c.beginPath();
    c.arc(bx + padX + 1, by + boxH / 2, 2.5, 0, Math.PI * 2);
    c.fill();
    // text
    c.fillStyle = "#e6e9f0";
    c.fillText(text, bx + padX + dotW, by + boxH / 2 + 0.5);
    c.restore();
  }

  function roundRect(
    c: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  // ---- click-to-open ----
  function onClick(ev: MouseEvent) {
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    let best: Entity | null = null;
    let bestD = Infinity;
    for (const e of entities.values()) {
      if (entityAlpha(e) < 0.3) continue;
      const sd = sheetForEntity(e);
      const usingImage = sd && loaded.get(sd.id);
      const sz = usingImage ? spriteSize(sd!, e.scale) : null;
      const spriteW = sz ? sz.w : DOLL_W * PIXEL * e.scale;
      const spriteH = sz ? sz.h : DOLL_H * PIXEL * e.scale;
      // hit-box centered horizontally on x, vertical from feet up
      const dx = Math.abs(mx - e.x);
      const cyTop = e.y - spriteH;
      const within = dx <= spriteW / 2 + 4 && my >= cyTop - 4 && my <= e.y + 4;
      if (within) {
        const d = Math.hypot(mx - e.x, my - (e.y - spriteH / 2));
        if (d < bestD) {
          bestD = d;
          best = e;
        }
      }
    }
    if (best) {
      selectSession(best.refId);
      setView("agents");
    }
  }

  // ---- canvas sizing / DPR ----
  function setupCanvas() {
    const rect = wrap.getBoundingClientRect();
    arenaW = Math.max(1, Math.floor(rect.width));
    arenaH = Math.max(1, Math.floor(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(arenaW * dpr);
    canvas.height = Math.floor(arenaH * dpr);
    ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
    }
  }

  // ---- rAF loop ----
  const tick = (now: number) => {
    const dt = Math.min(now - last, 50);
    last = now;
    update(dt);
    draw();
    raf = requestAnimationFrame(tick);
  };

  // Capture sessions reactively + reconcile entities on every change.
  createEffect(() => {
    liveSessions = sessions();
    syncEntities();
  });

  onMount(() => {
    setupCanvas();
    resizeObserver = new ResizeObserver(() => setupCanvas());
    resizeObserver.observe(wrap);
    canvas.addEventListener("click", onClick);
    // best-effort manifest fetch; procedural fallback if it fails.
    fetch("/sprites/manifest.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((m: Manifest | null) => {
        if (m) initSheets(m);
      })
      .catch(() => {
        /* procedural fallback only */
      });
    last = performance.now();
    raf = requestAnimationFrame(tick);
  });

  onCleanup(() => {
    cancelAnimationFrame(raf);
    resizeObserver?.disconnect();
    canvas?.removeEventListener("click", onClick);
  });

  // ---- reactive HUD (DOM + Solid) ----
  const counts = createMemo(() => {
    const ss = sessions();
    let running = 0,
      idle = 0,
      error = 0,
      subs = 0;
    for (const s of ss) {
      if (s.status === "running") running++;
      else if (s.status === "idle") idle++;
      else if (s.status === "error") error++;
      subs += s.subAgents.length;
    }
    return { total: ss.length, running, idle, error, subs };
  });

  const legendItem = (color: string, label: string) => html`
    <span class="li"><span class="swatch" style=${`background:${color}`}></span>${label}</span>
  `;

  return html`
    <div class="game-wrap" data-component="GameView" ref=${(el: HTMLDivElement) => (wrap = el)}>
      <canvas class="game-canvas" ref=${(el: HTMLCanvasElement) => (canvas = el)}></canvas>
      <div class="game-hud">
        <div class="stat">
          <span class="dot" classList=${() => ({ on: connected() })}></span>
          <strong>Arena</strong>
          <span class="conn">${() => (connected() ? "live" : "offline")}</span>
        </div>
        <div class="stat counts">
          <span>${() => counts().total} agents</span>
          <span class="c-run">${() => counts().running} running</span>
          <span class="c-idle">${() => counts().idle} idle</span>
          ${() => (counts().error ? html`<span class="c-err">${counts().error} error</span>` : "")}
          ${() => (counts().subs ? html`<span class="c-sub">${counts().subs} sub-agents</span>` : "")}
        </div>
        <div class="legend">
          ${legendItem(STATUS_DOT.running, "running")}
          ${legendItem(STATUS_DOT.idle, "idle")}
          ${legendItem(STATUS_DOT.starting, "starting")}
          ${legendItem(STATUS_DOT.done, "done")}
          ${legendItem(STATUS_DOT.error, "error")}
        </div>
      </div>
      <div class="game-hint">click a character to open its conversation</div>
    </div>
  `;
}
