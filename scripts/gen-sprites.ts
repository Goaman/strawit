// Sprite generation script (standalone Bun script — NOT part of the server).
//
// Calls the Gemini image API to generate a set of pixel-art walk-cycle sprite
// strips, writes each as a PNG into app/public/sprites/, and emits a manifest
// describing the frame geometry. The client color-keys the magenta background to
// transparent at load time and samples frames by equal-width column rectangles,
// so this script does NO image processing (no extra deps) — it only needs the
// PNG's real pixel dimensions, which it reads straight from the PNG header.
//
// Run:  bun run scripts/gen-sprites.ts
// Flags: --only <id>   regenerate a single character
//        --frames <n>  override the walk-cycle frame count (default 4)
//        --dry-run     print prompts without calling the API

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "app", "public", "sprites");

const MODEL = "gemini-3-pro-image";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// ---- credentials: read ~/.env_ai directly (the app's env.ts loads a different file) ----
function loadKey(): string {
  const path = join(homedir(), ".env_ai");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Could not read ${path} — Gemini API key not available.`);
  }
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  const key = env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!key) throw new Error("No GEMINI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY in ~/.env_ai");
  return key;
}

// ---- characters ----
const CHARACTERS: { id: string; desc: string }[] = [
  { id: "knight", desc: "knight in shiny blue armor with a small sword" },
  { id: "wizard", desc: "purple wizard with a pointed hat and a glowing staff" },
  { id: "ranger", desc: "green-hooded forest ranger with a bow" },
  { id: "robot", desc: "boxy red robot with antenna and glowing eyes" },
  { id: "fox", desc: "cute orange fox creature standing on two legs" },
  { id: "slime", desc: "bouncy cyan slime blob with two eyes" },
  { id: "bard", desc: "cheerful yellow bard with a lute" },
  { id: "ninja", desc: "grey cat ninja with a mask and a katana" },
];

function prompt(desc: string, n: number): string {
  return [
    `Pixel-art sprite sheet, side-view, of a ${desc} walking.`,
    `Produce EXACTLY ${n} frames of a left-to-right walk cycle, arranged in a SINGLE`,
    `horizontal row, evenly spaced, each frame the same size, all facing RIGHT.`,
    `Flat solid magenta background (#FF00FF) with NO gradients, NO shadows on the`,
    `background, NO text, NO grid lines, NO numbers. Characters fully contained within`,
    `their frame with a consistent baseline (feet aligned). Crisp pixel-art, limited`,
    `palette, 1px dark outline. Clean and centered.`,
  ].join(" ");
}

// ---- image dimensions from the header (no deps) ----
// The model may return PNG or JPEG. Detect either and read width/height from the
// header. The client color-keys the magenta background to transparent regardless
// of format and samples frames by equal-width column rectangles.
type ImgInfo = { width: number; height: number; ext: "png" | "jpg" };

function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: dv.getUint32(16, false), height: dv.getUint32(20, false) };
}

// JPEG: scan markers for a Start-Of-Frame (SOFn) segment; height/width are
// big-endian uint16 at offsets 5 and 7 within that segment.
function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];
    // SOF markers: C0-CF except C4 (DHT), C8 (JPG), CC (DAC)
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      return { width, height };
    }
    // skip this segment using its length
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2) break;
    i += 2 + len;
  }
  return null;
}

function imageInfo(bytes: Uint8Array): ImgInfo | null {
  const p = pngSize(bytes);
  if (p) return { ...p, ext: "png" };
  const j = jpegSize(bytes);
  if (j) return { ...j, ext: "jpg" };
  return null;
}

async function generateOne(
  key: string,
  desc: string,
  frames: number,
  dryRun: boolean,
): Promise<Uint8Array | null> {
  const text = prompt(desc, frames);
  if (dryRun) {
    console.log(`  PROMPT: ${text}`);
    return null;
  }
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body.slice(0, 400)}`);
  }
  const json: any = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    const data = p?.inlineData?.data;
    if (data) return Uint8Array.from(Buffer.from(data, "base64"));
  }
  throw new Error("No inlineData image in response");
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  let only: string | null = null;
  let frames = 4;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only") only = argv[++i];
    else if (argv[i] === "--frames") frames = Number(argv[++i]) || 4;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const key = dryRun ? "" : loadKey();

  const targets = only ? CHARACTERS.filter((c) => c.id === only) : CHARACTERS;
  if (!targets.length) {
    console.error(`No character matches --only ${only}`);
    process.exit(1);
  }

  // Load existing manifest so a partial regen (--only) preserves other sheets.
  const manifestPath = join(OUT_DIR, "manifest.json");
  const sheetsById = new Map<string, any>();
  try {
    const existing = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const s of existing.sheets ?? []) sheetsById.set(s.id, s);
  } catch {
    /* no existing manifest */
  }

  for (const ch of targets) {
    console.log(`Generating "${ch.id}" (${ch.desc})…`);
    try {
      const bytes = await generateOne(key, ch.desc, frames, dryRun);
      if (!bytes) continue; // dry-run
      const info = imageInfo(bytes);
      if (!info) {
        console.error(`  ! returned image for ${ch.id} is not a valid PNG/JPEG — skipping`);
        continue;
      }
      const file = join(OUT_DIR, `${ch.id}.${info.ext}`);
      writeFileSync(file, bytes);
      const frameW = Math.floor(info.width / frames);
      sheetsById.set(ch.id, {
        id: ch.id,
        file: `/sprites/${ch.id}.${info.ext}`,
        frameW,
        frameH: info.height,
        frames,
        cols: frames,
      });
      console.log(
        `  wrote ${file} — ${bytes.length} bytes, ${info.width}x${info.height} (frameW=${frameW})`,
      );
    } catch (err) {
      console.error(`  ! failed for ${ch.id}:`, (err as Error).message);
    }
  }

  if (!dryRun) {
    const manifest = { sheets: [...sheetsById.values()] };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`\nWrote manifest: ${manifestPath} (${manifest.sheets.length} sheets)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
