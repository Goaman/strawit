// Rich rendering for `tool_use` transcript entries.
//
// Instead of dumping a raw (truncated) JSON blob, each tool call becomes a
// compact card: a category-coloured icon, a human-readable title, an inline
// one-line summary of the key argument, and an expandable, syntax-highlighted
// view of the full parameters. Expansion state is persisted per session+entry
// via the shared collapse store.

import html from "solid-js/html";
import { escapeHtml } from "./markdown.ts";
import { isCollapsed, toggleCollapse } from "./collapse.ts";
import type { TranscriptEntry } from "../types.ts";

// ---- tool identity → icon / title / category --------------------------------

type Cat = "exec" | "file" | "search" | "skill" | "mcp" | "agent" | "web" | "todo" | "default";

interface ToolMeta {
  icon: string;
  title: string; // primary label (the tool, prettified)
  subtitle?: string; // secondary context (e.g. the MCP server)
  badge?: string; // small uppercase tag (e.g. "MCP", "SKILL")
  cat: Cat;
}

// Per-known-tool overrides. Anything not listed falls back to a sensible guess
// (including the `mcp__server__name` convention).
const KNOWN: Record<string, { icon: string; cat: Cat; title?: string }> = {
  Bash: { icon: "⌘", cat: "exec" },
  BashOutput: { icon: "📤", cat: "exec" },
  KillShell: { icon: "🛑", cat: "exec" },
  Read: { icon: "📄", cat: "file" },
  Write: { icon: "✏️", cat: "file" },
  Edit: { icon: "📝", cat: "file" },
  MultiEdit: { icon: "📝", cat: "file" },
  NotebookEdit: { icon: "📓", cat: "file" },
  Glob: { icon: "🗂️", cat: "file" },
  Grep: { icon: "🔎", cat: "search" },
  ToolSearch: { icon: "🔍", cat: "search" },
  WebSearch: { icon: "🌐", cat: "search" },
  WebFetch: { icon: "🌐", cat: "web" },
  Skill: { icon: "🧩", cat: "skill" },
  Task: { icon: "🤖", cat: "agent" },
  Agent: { icon: "🤖", cat: "agent" },
  TodoWrite: { icon: "✅", cat: "todo" },
  ExitPlanMode: { icon: "📋", cat: "default" },
};

function titleCase(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function toolMeta(tool: string): ToolMeta {
  const name = tool || "tool";

  // MCP tools follow `mcp__<server>__<tool>`.
  const mcp = name.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
  if (mcp) {
    return {
      icon: "🔌",
      title: titleCase(mcp[2]),
      subtitle: mcp[1],
      badge: "MCP",
      cat: "mcp",
    };
  }

  const known = KNOWN[name];
  if (known) {
    return {
      icon: known.icon,
      title: known.title ?? name,
      badge: known.cat === "skill" ? "SKILL" : undefined,
      cat: known.cat,
    };
  }

  return { icon: "🔧", title: name, cat: "default" };
}

// ---- one-line summary of the most meaningful argument -----------------------

function firstString(input: Record<string, unknown>): string | undefined {
  for (const v of Object.values(input)) {
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

// Pick the field that best describes the call, per tool. Falls back to the first
// stringy field, then a compact JSON rendering.
function summarize(tool: string, input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  if (typeof input !== "object") return String(input);

  const o = input as Record<string, unknown>;
  const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);

  const mcp = tool.match(/^mcp__/);
  let pick: string | undefined;

  if (tool === "Bash") pick = s("command") ?? s("description");
  else if (tool === "Read" || tool === "Write" || tool === "Edit" || tool === "MultiEdit")
    pick = s("file_path") ?? s("notebook_path");
  else if (tool === "Glob") pick = s("pattern") ? `${s("pattern")}${s("path") ? ` in ${s("path")}` : ""}` : undefined;
  else if (tool === "Grep") pick = s("pattern");
  else if (tool === "ToolSearch" || tool === "WebSearch") pick = s("query");
  else if (tool === "WebFetch") pick = s("url") ?? s("prompt");
  else if (tool === "Skill") pick = [s("skill"), s("args")].filter(Boolean).join(" — ");
  else if (tool === "Task" || tool === "Agent") pick = s("description") ?? s("prompt");
  else if (mcp) pick = s("prompt") ?? s("query") ?? s("description");
  else if (tool === "TodoWrite" && Array.isArray(o.todos)) pick = `${o.todos.length} todo(s)`;

  if (!pick) pick = firstString(o);
  if (!pick) {
    try {
      pick = JSON.stringify(o);
    } catch {
      pick = String(o);
    }
  }
  return pick.replace(/\s+/g, " ").trim();
}

// Whether there is anything worth expanding (a non-trivial object/string).
function hasDetail(input: unknown): boolean {
  if (input == null) return false;
  if (typeof input === "string") return input.length > 0;
  if (typeof input === "object") return Object.keys(input as object).length > 0;
  return true;
}

// ---- pretty + lightly syntax-highlighted JSON -------------------------------

export function highlightJson(value: unknown): string {
  let json: string;
  try {
    json = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
  } catch {
    json = String(value);
  }
  // Scan the raw JSON, escaping the gaps and each matched token so embedded
  // < > & in strings stay literal. Tokens: strings (optionally a key, when a
  // colon follows), numbers, and the keywords true/false/null.
  const re = /"(?:\\.|[^"\\])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(json))) {
    out += escapeHtml(json.slice(last, m.index));
    const tok = m[0];
    let cls = "tc-num";
    if (tok[0] === '"') cls = m[1] ? "tc-key" : "tc-str";
    else if (tok === "true" || tok === "false") cls = "tc-bool";
    else if (tok === "null") cls = "tc-null";
    out += `<span class="${cls}">${escapeHtml(tok)}</span>`;
    last = m.index + tok.length;
  }
  out += escapeHtml(json.slice(last));
  return out;
}

// ---- the widget -------------------------------------------------------------

export function ToolCall(props: { e: TranscriptEntry; sid: string }) {
  const e = props.e;
  const meta = toolMeta(e.tool ?? "tool");

  // Prefer the structured input; fall back to parsing the (possibly truncated)
  // text, then to the raw text itself.
  let input: unknown = e.toolInput;
  if (input === undefined && e.text) {
    try {
      input = JSON.parse(e.text);
    } catch {
      input = e.text;
    }
  }

  const summary = summarize(e.tool ?? "", input);
  const expandable = hasDetail(input);
  // Persisted, namespaced per session so entry-id reuse across sessions doesn't
  // bleed. Presence in the collapse set means "open" here (default: closed).
  const cid = `tool:${props.sid}:${e.id}`;

  return html`
    <div class=${`tool-call tc-${meta.cat}`} classList=${() => ({ open: expandable && isCollapsed(cid) })}>
      <div class=${expandable ? "tc-head clickable" : "tc-head"}
        onClick=${() => expandable && toggleCollapse(cid)}>
        <span class="tc-icon">${meta.icon}</span>
        <span class="tc-title">${meta.title}</span>
        ${meta.subtitle ? html`<span class="tc-sub">${meta.subtitle}</span>` : ""}
        ${meta.badge ? html`<span class="tc-badge">${meta.badge}</span>` : ""}
        ${summary ? html`<span class="tc-summary">${summary}</span>` : ""}
        ${expandable
          ? html`<span class="caret tc-caret" classList=${() => ({ collapsed: !isCollapsed(cid) })}>▾</span>`
          : ""}
      </div>
      ${() =>
        expandable && isCollapsed(cid)
          ? html`<pre class="tc-params"><code innerHTML=${highlightJson(input)}></code></pre>`
          : ""}
    </div>
  `;
}
