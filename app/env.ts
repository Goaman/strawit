// Shared credential loader. The server can be launched from any directory
// (the repo root, a worktree, the TUI…), so we don't rely on Bun's cwd-only
// .env auto-load. All of the app's secrets — the Soda Straw / Linear gateway
// (linear-gateway.ts) and the Supabase session store (persistence.ts) — are
// read from a single, machine-wide file: ~/.strawit/.env (override with
// STRAWIT_ENV_FILE).
//
// Importing this module loads that file as a side effect, once, before anything
// reads process.env. Only keys that aren't already set are filled in, so an
// explicit env var or a cwd .env (which Bun loads before any code runs) always
// wins. Modules that read these vars at import time should import this module
// *first* so the load happens before their config constants are evaluated.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let loaded = false;

export function loadStrawitEnv(): void {
  if (loaded) return;
  loaded = true;

  const path = process.env.STRAWIT_ENV_FILE || join(homedir(), ".strawit", ".env");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // no file there — rely on the ambient environment / cwd .env
  }

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
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadStrawitEnv();
