// Rich rendering for `tool_use` transcript entries.
//
// Rather than a raw JSON dump, a tool call reads as a calm activity line:
// a dimmed, humanised label ("Searching the web ⌄") that expands into a
// thin-ruled timeline — the call itself (wrench), its parameters tucked behind
// a quiet pill, and a "Done" marker. Monochrome by design, so a long transcript
// stays restful. Expansion state persists per session+entry via the collapse
// store.

import html from "solid-js/html";
import { escapeHtml } from "./markdown.ts";
import { isCollapsed, toggleCollapse } from "./collapse.ts";
import type { TranscriptEntry } from "../types.ts";

// Thin line icons (Lucide), kept monochrome via currentColor to match the
// understated aesthetic — emoji would read as chunky/loud here.
const ICON_ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
const WRENCH = `<svg ${ICON_ATTRS}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`;
const CHECK = `<svg ${ICON_ATTRS}><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`;

// Humanise a tool name into a calm activity label.
const LABELS: Record<string, string> = {
  Bash: "Running a command",
  BashOutput: "Reading command output",
  KillShell: "Stopping a command",
  Read: "Reading a file",
  Write: "Writing a file",
  Edit: "Editing a file",
  MultiEdit: "Editing a file",
  NotebookEdit: "Editing a notebook",
  Glob: "Finding files",
  Grep: "Searching the code",
  ToolSearch: "Looking up tools",
  WebSearch: "Searching the web",
  WebFetch: "Fetching a page",
  Skill: "Using a skill",
  Task: "Delegating to an agent",
  Agent: "Delegating to an agent",
  TodoWrite: "Updating the plan",
  ExitPlanMode: "Finishing the plan",
};

export function humanize(raw: string): string {
  if (!raw) return "Working";
  if (LABELS[raw]) return LABELS[raw];
  // mcp__server__some_tool → "Some tool"
  const mcp = raw.match(/^mcp__[^_]+(?:_[^_]+)*?__(.+)$/);
  const name = mcp ? mcp[1] : raw;
  const words = name.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : raw;
}

// Pretty-print parameters as plain, dimmed text (no loud syntax colours).
function prettyParams(input: unknown): string {
  let s: string;
  try {
    s = typeof input === "string" ? input : (JSON.stringify(input, null, 2) ?? String(input));
  } catch {
    s = String(input);
  }
  return escapeHtml(s);
}

function hasParams(input: unknown): boolean {
  if (input == null) return false;
  if (typeof input === "string") return input.trim().length > 0;
  if (typeof input === "object") return Object.keys(input as object).length > 0;
  return true;
}

export function ToolCall(props: { e: TranscriptEntry; sid: string }) {
  const e = props.e;
  const label = humanize(e.tool ?? "tool");

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
  const params = hasParams(input);

  // Two independent, persisted disclosures: the whole activity, and (nested)
  // the raw parameters. Namespaced per session so reused entry ids don't bleed.
  // Presence in the collapse set means "open" (default: closed → calm one-liner).
  const oid = `tool:${props.sid}:${e.id}`;
  const pid = `toolp:${props.sid}:${e.id}`;

  return html`
    <div class="tool-call">
      <button class="tc-toggle" classList=${() => ({ open: isCollapsed(oid) })}
        onClick=${() => toggleCollapse(oid)}>
        <span class="tc-label">${label}</span>
        <span class="tc-chevron">⌄</span>
      </button>
      ${() =>
        isCollapsed(oid)
          ? html`<div class="tc-body">
              <div class="tc-step">
                <span class="tc-ico" innerHTML=${WRENCH}></span>
                <span class="tc-step-label">${label}</span>
              </div>
              ${params
                ? html`<div class="tc-params-wrap">
                    <button class="tc-pill" classList=${() => ({ open: isCollapsed(pid) })}
                      onClick=${() => toggleCollapse(pid)}>Parameters</button>
                    ${() =>
                      isCollapsed(pid)
                        ? html`<pre class="tc-params"><code innerHTML=${prettyParams(input)}></code></pre>`
                        : ""}
                  </div>`
                : ""}
              <div class="tc-step tc-done">
                <span class="tc-ico" innerHTML=${CHECK}></span>
                <span class="tc-step-label">Done</span>
              </div>
            </div>`
          : ""}
    </div>
  `;
}
