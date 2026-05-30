// Durable persistence. Sessions (meta + transcript + sub-agent tree) live in
// Supabase so they survive a server restart *and* aren't tied to one machine.
// Worker runtime files (unix sockets, pid files, stdout capture) and per-session
// logs stay on local disk — they're inherently host-local and can't be shared.

// Load credentials (SUPABASE_URL/KEY) from ~/.strawit/.env before db() reads
// them. See app/env.ts — a single shared file holds all the app's secrets.
import "./env.ts";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { SessionSnapshot } from "./types.ts";

// Local-only runtime/log directory (NOT session storage — see Supabase below).
export const DATA_DIR = process.env.AGENT_CONSOLE_DIR || join(homedir(), ".agent-console");
export const LOG_DIR = join(DATA_DIR, "logs");
// Per-session worker runtime files: the unix socket the worker listens on, its
// pid file, and its stdout/stderr capture. These let a restarted server find
// and re-attach to workers that outlived it.
export const WORKERS_DIR = join(DATA_DIR, "workers");
mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(WORKERS_DIR, { recursive: true });

export function logPathFor(id: string): string {
  return join(LOG_DIR, `${id}.log`);
}

// Unix-domain socket a session worker listens on. macOS caps socket paths at
// ~104 chars, so we keep DATA_DIR shallow and the id short (it already is).
export function socketPathFor(id: string): string {
  return join(WORKERS_DIR, `${id}.sock`);
}

export function pidPathFor(id: string): string {
  return join(WORKERS_DIR, `${id}.pid`);
}

// Where a detached worker's stdout/stderr is captured (for post-mortem debug).
export function workerOutPathFor(id: string): string {
  return join(WORKERS_DIR, `${id}.out`);
}

// ---- Supabase-backed session store ----

const TABLE = "sessions";

let client: SupabaseClient | null = null;
function db(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase is not configured: set SUPABASE_URL and SUPABASE_KEY in ~/.strawit/.env " +
        "(see .env.example). Sessions are stored in Supabase, so the app cannot start without them.",
    );
  }
  // Server-side usage: no auth session to persist or refresh.
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

// DB row <-> SessionSnapshot. Columns are snake_case; the domain type is camelCase.
type Row = {
  id: string;
  label: string;
  model: string | null;
  cwd: string;
  status: string;
  sdk_session_id: string | null;
  created_at: number;
  busy: boolean;
  live: boolean;
  transcript: SessionSnapshot["transcript"];
  sub_agents: SessionSnapshot["subAgents"];
};

function toRow(s: SessionSnapshot): Row {
  return {
    id: s.id,
    label: s.label,
    model: s.model,
    cwd: s.cwd,
    status: s.status,
    sdk_session_id: s.sdkSessionId,
    created_at: s.createdAt,
    busy: s.busy,
    live: s.live,
    transcript: s.transcript ?? [],
    sub_agents: s.subAgents ?? [],
  };
}

function fromRow(r: Row): SessionSnapshot {
  return {
    id: r.id,
    label: r.label,
    model: r.model,
    cwd: r.cwd,
    status: r.status as SessionSnapshot["status"],
    sdkSessionId: r.sdk_session_id,
    createdAt: Number(r.created_at),
    busy: r.busy,
    live: r.live,
    transcript: r.transcript ?? [],
    subAgents: r.sub_agents ?? [],
  };
}

export async function loadAll(): Promise<SessionSnapshot[]> {
  const { data, error } = await db()
    .from(TABLE)
    .select("*")
    .order("created_at", { ascending: true });
  if (error) {
    console.error("persistence.loadAll:", error.message);
    return [];
  }
  return (data as Row[]).map(fromRow);
}

export async function loadOne(id: string): Promise<SessionSnapshot | null> {
  const { data, error } = await db().from(TABLE).select("*").eq("id", id).maybeSingle();
  if (error) {
    console.error("persistence.loadOne:", error.message);
    return null;
  }
  return data ? fromRow(data as Row) : null;
}

export async function save(s: SessionSnapshot): Promise<void> {
  const { error } = await db()
    .from(TABLE)
    .upsert({ ...toRow(s), updated_at: new Date().toISOString() }, { onConflict: "id" });
  if (error) console.error("persistence.save:", error.message);
}

export async function remove(id: string): Promise<void> {
  const { error } = await db().from(TABLE).delete().eq("id", id);
  if (error) console.error("persistence.remove:", error.message);
}
