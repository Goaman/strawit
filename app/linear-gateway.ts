// Low-level client for driving Linear through the Soda Straw gateway.
//
// The board backend never talks to Linear directly — every call is proxied
// through Soda Straw's MCP gateway with a scoped agent API key (straw: linear).
// That keeps credentials, scope, and audit in Soda Straw rather than on this
// box. Config is read from the environment, loaded from ~/.strawit/.env (or
// STRAWIT_ENV_FILE, or a cwd .env / the ambient env):
//
//   SODA_STRAW_GATEWAY_URL   e.g. https://<workspace>.straw.../mcp
//   SODA_STRAW_API_KEY       scoped agent key (ssa_...)
//   SODA_STRAW_LINEAR_STRAW  straw name (default "linear")
//   LINEAR_TEAM_ID           the Linear team all projects/issues live under
//
// Wrinkle worth knowing: the upstream Linear MCP returns its payloads as
// *Python-repr strings* (single quotes, True/False/None, \n escapes) nested
// inside the JSON `result` field — so we JSON.parse the envelope, then run the
// inner string through a small Python-literal parser (parsePyLiteral).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Load credentials from a stable, machine-wide location so the server works no
// matter which directory (or worktree) it's launched from. ~/.strawit/.env is
// the canonical home (override with STRAWIT_ENV_FILE). Bun already auto-loads a
// .env in the cwd before any code runs; we only fill in keys that aren't set
// yet, so an explicit env / cwd .env always wins. This runs before the config
// constants below read process.env (module bodies execute top-to-bottom).
function loadEnvFile(): void {
  const path = process.env.STRAWIT_ENV_FILE || join(homedir(), ".strawit", ".env");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // no file there — rely on the ambient environment
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
loadEnvFile();

const GATEWAY_URL = process.env.SODA_STRAW_GATEWAY_URL || "";
const API_KEY = process.env.SODA_STRAW_API_KEY || "";
const STRAW = process.env.SODA_STRAW_LINEAR_STRAW || "linear";
export const TEAM_ID = process.env.LINEAR_TEAM_ID || "";

export function gatewayConfigured(): boolean {
  return Boolean(GATEWAY_URL && API_KEY && TEAM_ID);
}

export function gatewayConfigError(): string {
  const missing = [
    !GATEWAY_URL && "SODA_STRAW_GATEWAY_URL",
    !API_KEY && "SODA_STRAW_API_KEY",
    !TEAM_ID && "LINEAR_TEAM_ID",
  ].filter(Boolean);
  return `Soda Straw gateway not configured — missing ${missing.join(", ")} (set them in ~/.strawit/.env).`;
}

// ---- Python-literal parser --------------------------------------------------
// Just enough to parse repr() output: dicts, lists/tuples, single/double quoted
// strings with escapes, ints/floats, True/False/None.

export function parsePyLiteral(input: string): any {
  const s = input;
  let i = 0;
  const fail = (msg: string): never => {
    throw new Error(`parsePyLiteral: ${msg} at offset ${i}`);
  };
  const ws = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };

  function str(): string {
    const quote = s[i++];
    let out = "";
    while (i < s.length) {
      const ch = s[i++];
      if (ch === "\\") {
        const e = s[i++];
        switch (e) {
          case "n": out += "\n"; break;
          case "t": out += "\t"; break;
          case "r": out += "\r"; break;
          case "\\": out += "\\"; break;
          case "'": out += "'"; break;
          case '"': out += '"'; break;
          case "0": out += "\0"; break;
          case "x": out += String.fromCharCode(parseInt(s.slice(i, (i += 2)), 16)); break;
          case "u": out += String.fromCharCode(parseInt(s.slice(i, (i += 4)), 16)); break;
          default: out += e;
        }
      } else if (ch === quote) {
        return out;
      } else {
        out += ch;
      }
    }
    return fail("unterminated string");
  }

  function token(): any {
    const start = i;
    while (i < s.length && !/[,{}\[\]()\s:]/.test(s[i])) i++;
    const t = s.slice(start, i);
    if (t === "True") return true;
    if (t === "False") return false;
    if (t === "None") return null;
    if (t === "") return fail("empty token");
    const n = Number(t);
    return Number.isNaN(n) ? t : n;
  }

  function list(close: string): any[] {
    i++; // opening bracket
    const out: any[] = [];
    ws();
    if (s[i] === close) { i++; return out; }
    for (;;) {
      out.push(value());
      ws();
      if (s[i] === ",") { i++; ws(); if (s[i] === close) { i++; break; } continue; }
      if (s[i] === close) { i++; break; }
      return fail(`expected ',' or '${close}'`);
    }
    return out;
  }

  function dict(): Record<string, any> {
    i++; // {
    const out: Record<string, any> = {};
    ws();
    if (s[i] === "}") { i++; return out; }
    for (;;) {
      ws();
      const key = value();
      ws();
      if (s[i] !== ":") return fail("expected ':'");
      i++;
      out[String(key)] = value();
      ws();
      if (s[i] === ",") { i++; ws(); if (s[i] === "}") { i++; break; } continue; }
      if (s[i] === "}") { i++; break; }
      return fail("expected ',' or '}'");
    }
    return out;
  }

  function value(): any {
    ws();
    const c = s[i];
    if (c === undefined) return fail("unexpected end of input");
    if (c === "{") return dict();
    if (c === "[") return list("]");
    if (c === "(") return list(")");
    if (c === "'" || c === '"') return str();
    return token();
  }

  return value();
}

// ---- Gateway call -----------------------------------------------------------

// Call a Linear tool through Soda Straw and return the parsed result object.
// `intent` is the human-readable activity-feed note Soda Straw records.
export async function callLinear(
  toolName: string,
  args: Record<string, unknown> = {},
  intent?: string,
): Promise<any> {
  if (!gatewayConfigured()) throw new Error(gatewayConfigError());

  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "straws_call",
        arguments: {
          straw: STRAW,
          tool_name: toolName,
          arguments: { _intent: intent || `Strawit board: ${toolName}`, ...args },
        },
      },
    }),
  });

  if (!res.ok) throw new Error(`Soda Straw gateway HTTP ${res.status}`);

  const ct = res.headers.get("content-type") || "";
  let envelope: any;
  if (ct.includes("text/event-stream")) {
    const text = await res.text();
    const last = text.split("\n").filter((l) => l.startsWith("data:")).pop();
    if (!last) throw new Error("empty SSE response from gateway");
    envelope = JSON.parse(last.slice(5).trim());
  } else {
    envelope = await res.json();
  }

  if (envelope.error) {
    throw new Error(`gateway RPC error: ${envelope.error.message ?? JSON.stringify(envelope.error)}`);
  }
  const text = envelope.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("unexpected gateway result shape");

  // The straws_call envelope: { straw_id, tool, result: "<py-repr>" } or { error, message }.
  const inner = JSON.parse(text);
  if (inner.error) throw new Error(`linear (${toolName}): ${inner.message ?? inner.error}`);
  if (typeof inner.result !== "string") return inner.result ?? inner;
  return parsePyLiteral(inner.result);
}
