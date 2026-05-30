// SolidJS app, authored with the solid-js/html tagged-template (no JSX/babel
// step — Bun bundles this straight to public/client.js).

import { render } from "solid-js/web";
import html from "solid-js/html";
import { createEffect, createMemo, createSignal } from "solid-js";
import {
  actions,
  board,
  connect,
  connected,
  loadBoard,
  selectSession,
  selectSub,
  selected,
  selectedId,
  selectedSubKey,
  sessions,
  setView,
  taskById,
  view,
} from "./store.ts";
import { PmView } from "./pm.ts";
import { GameView } from "./game.ts";
import { confirmDialog, DialogHost, installGlobalErrorHandlers } from "./dialog.ts";
import { isCollapsed, toggleCollapse } from "./collapse.ts";
import { createComposer } from "./composer.ts";
import { renderMarkdown } from "./markdown.ts";
import { ToolGroup } from "./tool-call.ts";
import type { Project, SessionSnapshot, SubAgentNode, Task, TranscriptEntry } from "../types.ts";

// Recursive lineage of nested agents spawned via super_agent. Clicking a node
// focuses that sub-agent's conversation. Rebuilt whole whenever the session's
// subAgents array changes (cheap at demo scale).
function SubTreeImpl(nodes: SubAgentNode[], parent: string | null, sessionId: string): any {
  const kids = nodes.filter((n) => n.parentKey === parent);
  if (kids.length === 0) return "";
  return html`<div class="tree">
    ${kids.map((n: SubAgentNode) => {
      const hasKids = nodes.some((c) => c.parentKey === n.key);
      const cid = `node:${n.key}`;
      return html`
        <div class="tnode">
          <div class="tnode-row clickable"
            classList=${() => ({ "tnode-active": n.key === selectedSubKey() })}
            onClick=${(e: MouseEvent) => {
              e.stopPropagation();
              selectSub(sessionId, n.key);
            }}>
            ${hasKids
              ? html`<span class="caret" classList=${() => ({ collapsed: isCollapsed(cid) })}
                  title="collapse / expand children"
                  onClick=${(e: MouseEvent) => {
                    e.stopPropagation();
                    toggleCollapse(cid);
                  }}>▾</span>`
              : html`<span class="caret-spacer"></span>`}
            <span class="tstatus ${n.status}"></span>
            <span class="tdepth">L${n.depth}</span>
            <span class="tprompt">${n.prompt || "(no prompt)"}</span>
          </div>
          ${n.resultPreview
            ? html`<div class="tresult ${n.status}">↩ ${n.resultPreview}</div>`
            : ""}
          ${() => (hasKids && !isCollapsed(cid) ? SubTreeImpl(nodes, n.key, sessionId) : "")}
        </div>
      `;
    })}
  </div>`;
}

// Focused view of a single sub-agent: the prompt it was given, any agents it
// spawned, and the answer it returned. (Sub-agents run headless/one-shot, so
// this is the full conversation available for them — input, lineage, output.)
//
// Takes accessors rather than plain values so the detail updates in place as
// the live node/session change, without the caller having to tear down and
// rebuild the whole view on every event.
function SubAgentDetail(
  nodeAcc: () => SubAgentNode | undefined,
  sessionAcc: () => SessionSnapshot | undefined,
) {
  return html`
    <div class="sub-detail" data-component="SubAgentDetail">
      <header class="conv-head">
        <div>
          <button class="back"
            onClick=${() => {
              const s = sessionAcc();
              if (s) selectSession(s.id);
            }}>← ${() => sessionAcc()?.label ?? ""}</button>
          ${() => {
            const n = nodeAcc();
            return n ? html`<span class="badge ${n.status}">${STATUS_LABEL[n.status] ?? n.status}</span>` : "";
          }}
          <span class="sub-meta">${() => {
            const n = nodeAcc();
            return n ? `L${n.depth} · ${n.model ?? "default"}${n.pid ? ` · pid ${n.pid}` : ""}` : "";
          }}</span>
        </div>
      </header>
      <div class="transcript">
        <div class="entry user">
          <span class="who">spawned with</span>
          <div class="text">${() => nodeAcc()?.prompt || "(no prompt)"}</div>
        </div>
        ${() => {
          const n = nodeAcc();
          const s = sessionAcc();
          if (!n || !s) return "";
          return s.subAgents.some((c) => c.parentKey === n.key)
            ? html`<div class="entry system">
                <span class="who">spawned sub-agents</span>
                <div class="text">${SubTreeImpl(s.subAgents, n.key, s.id)}</div>
              </div>`
            : "";
        }}
        ${() => {
          const n = nodeAcc();
          if (!n) return "";
          return n.status === "done" || n.status === "error"
            ? html`<div class="entry ${n.status === "error" ? "error" : "result"}">
                <span class="who">returned</span>
                <div class="text">${n.result ?? n.resultPreview ?? "(no result)"}</div>
              </div>`
            : html`<div class="entry system">
                <span class="who">${n.status}</span>
                <div class="text">working…</div>
              </div>`;
        }}
      </div>
    </div>
  `;
}

const STATUS_LABEL: Record<string, string> = {
  starting: "starting",
  running: "running",
  idle: "ready",
  done: "closed",
  error: "error",
};

function Sidebar() {
  const [showForm, setShowForm] = createSignal(false);
  // Every session must belong to a task; this drives the (required) task picker.
  const [taskId, setTaskId] = createSignal<string>("");
  let labelEl!: HTMLInputElement;
  let modelEl!: HTMLSelectElement;
  let cwdEl!: HTMLInputElement;
  // Rich composer for the first message: text + image/element widgets + "/" menu.
  const composer = createComposer({
    rows: 4,
    placeholder: "e.g. List the files here and tell me what this project does. ( / for commands )",
    onSubmit: () => launch(),
  });

  // Load the board (projects + tasks) so the picker has options. Cheap; re-runs
  // whenever the form is opened so freshly-added tasks show up.
  const openForm = () => {
    setShowForm((v) => !v);
    if (showForm()) void loadBoard();
  };

  const selectedTask = (): Task | undefined =>
    board().tasks.find((t) => t.id === taskId());

  // When a task is picked, prefill the working dir from its cwd (the user can
  // still override it before launching).
  const onPickTask = (id: string) => {
    setTaskId(id);
    const t = board().tasks.find((x) => x.id === id);
    if (t && cwdEl && !cwdEl.value.trim()) cwdEl.value = t.cwd ?? "";
  };

  const launch = () => {
    const prompt = composer.composeMessage().trim();
    const images = composer.payloadImages();
    if (!prompt && !images.length) return;
    // A task is optional: if none is picked the server auto-creates one so the
    // session is still tracked on the board.
    actions.create({
      prompt,
      images: images.length ? images : undefined,
      label: labelEl.value.trim() || selectedTask()?.title || undefined,
      model: modelEl.value || undefined,
      cwd: cwdEl.value.trim() || undefined,
      taskId: taskId(),
    });
    composer.clear();
    labelEl.value = "";
    setTaskId("");
    setShowForm(false);
  };

  return html`
    <aside class="sidebar" data-component="Sidebar">
      <div class="brand">
        <span class="dot" classList=${() => ({ on: connected() })}></span>
        <strong>Agent Console</strong>
        <span class="conn">${() => (connected() ? "live" : "offline")}</span>
      </div>

      <button class="primary" onClick=${openForm}>
        ${() => (showForm() ? "✕ cancel" : "+ new agent")}
      </button>

      ${() =>
        showForm() &&
        html`
          <div class="form" data-component="NewAgentForm">
            <label>task (optional)</label>
            <select onChange=${(e: Event) => onPickTask((e.target as HTMLSelectElement).value)}>
              <option value="" selected=${() => !taskId()}>— none (auto-create a task) —</option>
              ${() =>
                board().projects.map((p: Project) => {
                  const tasks = board().tasks.filter((t: Task) => t.projectId === p.id);
                  if (!tasks.length) return "";
                  return html`<optgroup label=${p.name}>
                    ${tasks.map(
                      (t: Task) =>
                        html`<option value=${t.id} selected=${() => taskId() === t.id}>${t.title}</option>`,
                    )}
                  </optgroup>`;
                })}
            </select>
            ${() =>
              board().tasks.length === 0
                ? html`<span class="hint">No tasks yet — leave this as "none" and one will be created for you.</span>`
                : ""}
            <label>task / first message</label>
            ${composer.node}
            <label>label (optional)</label>
            <input ref=${(el: HTMLInputElement) => (labelEl = el)} placeholder="my agent" />
            <label>model</label>
            <select ref=${(el: HTMLSelectElement) => (modelEl = el)}>
              <option value="">inherit / default</option>
              <option value="haiku">haiku (fast)</option>
              <option value="sonnet">sonnet</option>
              <option value="opus">opus</option>
            </select>
            <label>working dir (optional)</label>
            <input ref=${(el: HTMLInputElement) => (cwdEl = el)} placeholder="server cwd" />
            <button class="primary" onClick=${launch}
              title=${() => (!taskId() ? "launch agent (a task will be auto-created)" : "launch agent")}>launch agent</button>
          </div>
        `}

      <div class="list">
        ${() =>
          sessions().length === 0
            ? html`<p class="empty">No agents yet. Launch one above.</p>`
            : sessions().map((s: SessionSnapshot) => {
                const sid = `side:${s.id}`;
                return html`
                  <div class="item" data-component="SessionItem"
                    classList=${() => ({ active: s.id === selectedId() })}
                    onClick=${() => selectSession(s.id)}>
                    <div class="item-top">
                      <span class="name">${s.label}</span>
                      <span class="badge ${s.status}">${STATUS_LABEL[s.status] ?? s.status}</span>
                    </div>
                    ${() => {
                      const t = taskById(s.taskId);
                      return t
                        ? html`<div class="item-task" title="task this session belongs to">📋 ${t.title}</div>`
                        : "";
                    }}
                    <div class="item-sub">
                      ${s.model ?? "default"} · ${() => s.transcript.length} lines
                      ${() =>
                        s.subAgents.length
                          ? html`<span class="sub-count clickable"
                              title="collapse / expand sub-agents"
                              onClick=${(e: MouseEvent) => {
                                e.stopPropagation();
                                toggleCollapse(sid);
                              }}>· ${() => (isCollapsed(sid) ? "▸" : "▾")} ${s.subAgents.length} sub-agents</span>`
                          : ""}
                      ${() => (s.busy ? html`<span class="spinner"></span>` : "")}
                    </div>
                    ${() =>
                      s.subAgents.length && !isCollapsed(sid)
                        ? SubTreeImpl(s.subAgents, null, s.id)
                        : ""}
                  </div>
                `;
              })}
      </div>
    </aside>
  `;
}

// Fold a transcript into render items, collapsing each run of consecutive
// tool calls into one group (so they share a single linked timeline + Done).
type RenderItem =
  | { kind: "entry"; entry: TranscriptEntry }
  | { kind: "tools"; entries: TranscriptEntry[] };

function groupTranscript(transcript: TranscriptEntry[]): RenderItem[] {
  const items: RenderItem[] = [];
  let run: TranscriptEntry[] | null = null;
  for (const e of transcript) {
    if (e.kind === "tool_use") {
      if (!run) {
        run = [];
        items.push({ kind: "tools", entries: run });
      }
      run.push(e);
    } else {
      run = null;
      items.push({ kind: "entry", entry: e });
    }
  }
  return items;
}

function Entry(props: { e: TranscriptEntry; sid: string }) {
  const e = props.e;
  const head =
    e.kind === "user"
      ? "you"
      : e.kind === "assistant"
        ? "agent"
        : e.kind;
  return html`
    <div class="entry ${e.kind}" data-component="TranscriptEntry">
      <span class="who">${head}</span>
      ${e.images && e.images.length
        ? html`<div class="entry-images">
            ${e.images.map(
              (img) => html`<img class="entry-img"
                src=${`data:${img.mediaType};base64,${img.data}`} alt=${img.name ?? "image"} />`,
            )}
          </div>`
        : ""}
      ${e.text
        ? e.kind === "assistant"
          ? html`<div class="text markdown" innerHTML=${renderMarkdown(e.text)}></div>`
          : html`<div class="text">${e.text}</div>`
        : ""}
    </div>
  `;
}

function Conversation() {
  let scroller!: HTMLDivElement;
  // Rich composer: text + element/image widgets + "/" command menu. Created once
  // here so the input (and any in-progress draft) survives transcript updates.
  const composer = createComposer({
    rows: 2,
    placeholder: () =>
      selected()?.live
        ? "Message this agent (⌘/Ctrl+Enter to send, / for commands)…"
        : "Send to resume this conversation (⌘/Ctrl+Enter, / for commands)…",
    submitLabel: () => (selected()?.live ? "send" : "resume"),
    onSubmit: () => sendMsg(),
  });

  // Whether the transcript is pinned to the bottom. While true, new entries
  // auto-scroll into view; once the user scrolls up to read history it flips
  // false and stays there until they scroll all the way back down.
  const [stickToBottom, setStickToBottom] = createSignal(true);
  // Tolerance (px) for "completely at the bottom" — covers sub-pixel rounding.
  const BOTTOM_EPSILON = 4;
  const isAtBottom = (el: HTMLElement) =>
    el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_EPSILON;

  // Auto-scroll to the newest entry whenever the selected session's transcript
  // grows — but only while pinned to the bottom. If the user has scrolled up,
  // leave their position untouched until they scroll back down completely.
  createEffect(() => {
    const s = selected();
    s?.transcript.length; // track
    if (!stickToBottom()) return;
    queueMicrotask(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  });

  const sendMsg = () => {
    const s = selected();
    const text = composer.composeMessage().trim();
    const images = composer.payloadImages();
    if (!s || (!text && !images.length)) return;
    actions.message(s.id, text, images.length ? images : undefined);
    composer.clear();
  };

  // The focused sub-agent (if any) for the selected session, tracked reactively.
  const focusedSub = (): SubAgentNode | undefined => {
    const key = selectedSubKey();
    if (!key) return undefined;
    return selected()?.subAgents.find((n) => n.key === key);
  };

  // Which top-level layout to show. A *memo* (not a raw accessor) so that the
  // steady stream of session/transcript updates — every one of which produces a
  // fresh `selected()` object reference — only re-runs the outer branch when the
  // layout actually changes. Without this, an incoming event would tear down and
  // rebuild the whole conversation subtree, recreating the composer <textarea>
  // and wiping whatever the user was typing. This is the crux of the fine-grained
  // reactivity fix.
  const mode = createMemo<"none" | "sub" | "conv">(() => {
    if (!selected()) return "none";
    return focusedSub() ? "sub" : "conv";
  });

  // Clear the draft + attachments when the user switches to a *different*
  // session (matching the previous tear-down behaviour), but NOT when events
  // arrive for the current one — those must leave the in-progress message alone.
  let lastId: string | null = null;
  createEffect(() => {
    const id = selectedId();
    if (id !== lastId) {
      lastId = id;
      composer.clear();
    }
  });

  // The conversation shell. Built once while `mode` stays "conv"; the header,
  // sub-agent panel and transcript update through their own leaf accessors,
  // and the composer <textarea> is never recreated — so input survives events.
  const conversation = () => html`
    <header class="conv-head" data-component="ConversationHeader">
      <div>
        <strong>${() => selected()?.label ?? ""}</strong>
        ${() => {
          const s = selected();
          return s ? html`<span class="badge ${s.status}">${STATUS_LABEL[s.status] ?? s.status}</span>` : "";
        }}
        ${() => {
          const s = selected();
          return s && !s.live ? html`<span class="badge dormant">dormant</span>` : "";
        }}
      </div>
      <div class="head-actions">
        ${() => {
          const s = selected();
          if (!s || !s.live) return "";
          return html`<button onClick=${() => actions.interrupt(s.id)} disabled=${() => !selected()?.busy}>interrupt</button>
                 <button onClick=${() => actions.close(s.id)}>close</button>`;
        }}
        <button class="danger"
          onClick=${async () => {
            const s = selected();
            if (
              s &&
              (await confirmDialog({
                title: "Delete agent",
                message: `Delete "${s.label}" permanently?`,
                confirmLabel: "Delete",
                danger: true,
              }))
            )
              actions.remove(s.id);
          }}>delete</button>
      </div>
    </header>

    ${() => {
      const s = selected();
      if (!s || !s.subAgents.length) return "";
      const pid = `subpanel:${s.id}`;
      return html`<div class="subagents-panel" data-component="SubAgentTree">
        <div class="panel-title clickable" onClick=${() => toggleCollapse(pid)}>
          <span class="caret" classList=${() => ({ collapsed: isCollapsed(pid) })}>▾</span>
          🌿 sub-agent tree (${s.subAgents.length}) —
          ${() => (isCollapsed(pid) ? "click to expand" : "click a node to open it")}
        </div>
        ${() => (isCollapsed(pid) ? "" : SubTreeImpl(s.subAgents, null, s.id))}
      </div>`;
    }}

    <div class="transcript" data-component="Transcript" ref=${(el: HTMLDivElement) => {
      scroller = el;
      // A freshly-mounted transcript (e.g. after switching sessions)
      // starts pinned to the bottom.
      setStickToBottom(true);
      el.addEventListener("scroll", () => setStickToBottom(isAtBottom(el)));
    }}>
      ${() => {
        const s = selected();
        if (!s) return "";
        if (s.transcript.length === 0) return html`<p class="empty">Waiting for the agent…</p>`;
        return groupTranscript(s.transcript).map((it) =>
          it.kind === "tools"
            ? html`<${ToolGroup} entries=${it.entries} sid=${s.id} />`
            : html`<${Entry} e=${it.entry} sid=${s.id} />`,
        );
      }}
    </div>

    ${composer.node}
  `;

  return html`
    <main class="main" data-component="Conversation">
      ${() => {
        const m = mode();
        if (m === "none") return html`<div class="placeholder">Select or launch an agent.</div>`;
        if (m === "sub") return SubAgentDetail(focusedSub, selected);
        return conversation();
      }}
    </main>
  `;
}

function TopNav() {
  const tab = (id: "agents" | "pm" | "game", label: string) => html`
    <button class="tab" classList=${() => ({ active: view() === id })}
      onClick=${() => setView(id)}>${label}</button>
  `;
  return html`
    <nav class="topnav" data-component="TopNav">
      ${tab("agents", "Agents")}
      ${tab("pm", "Projects")}
      ${tab("game", "Game")}
    </nav>
  `;
}

function App() {
  return html`<div class="root-shell" data-component="App">
    <${TopNav} />
    ${() =>
      view() === "pm"
        ? html`<${PmView} />`
        : view() === "game"
          ? html`<${GameView} />`
          : html`<div class="app"><${Sidebar} /><${Conversation} /></div>`}
    <${DialogHost} />
  </div>`;
}

// Surface any otherwise-unhandled runtime error or promise rejection in a
// dialog instead of letting it fail silently in the console.
installGlobalErrorHandlers();
connect();
// Load the board once at startup so session rows can show their task label
// without first opening the new-agent form or the Projects tab.
void loadBoard();
render(App, document.getElementById("root")!);
