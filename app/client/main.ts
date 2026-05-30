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
import { confirmDialog, DialogHost, installGlobalErrorHandlers } from "./dialog.ts";
import { isCollapsed, toggleCollapse } from "./collapse.ts";
import { createImagePicker, type PickedImage } from "./images.ts";
import { renderMarkdown } from "./markdown.ts";
import type { Project, SessionSnapshot, SubAgentNode, Task, TranscriptEntry } from "../types.ts";

// Shared bits of the image-attachment UI, reused by the composer and the
// new-agent form. `picker` comes from createImagePicker().
type Picker = ReturnType<typeof createImagePicker>;

// A "📎" button that opens a (hidden) multi-image file chooser.
function AttachButton(picker: Picker) {
  let fileEl!: HTMLInputElement;
  return html`
    <span class="attach">
      <input type="file" accept="image/*" multiple class="attach-input"
        ref=${(el: HTMLInputElement) => (fileEl = el)}
        onChange=${(e: Event) => {
          const input = e.currentTarget as HTMLInputElement;
          if (input.files) void picker.addFiles(input.files);
          input.value = ""; // allow re-picking the same file
        }} />
      <button type="button" class="attach-btn" title="Attach image(s)"
        onClick=${() => fileEl.click()}>📎</button>
    </span>
  `;
}

// A strip of thumbnails for the currently-attached images, each removable.
function AttachStrip(picker: Picker) {
  // Return a reactive accessor (not a root-less `html\`${...}\`` template):
  // solid-js/html can't compile a template whose root is a bare expression
  // (it emits `_$el = .firstChild` → SyntaxError), and a function child is
  // inserted reactively by the parent template all the same.
  return () =>
    picker.images().length
      ? html`<div class="attach-strip">
          ${() =>
            picker.images().map(
              (img: PickedImage) => html`
                <div class="thumb" title=${img.name}>
                  <img src=${img.url} alt=${img.name} />
                  <button type="button" class="thumb-x" title="Remove"
                    onClick=${() => picker.remove(img.id)}>✕</button>
                </div>
              `,
            )}
        </div>`
      : "";
}

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
    <div class="sub-detail">
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
  const picker = createImagePicker();
  let promptEl!: HTMLTextAreaElement;
  let labelEl!: HTMLInputElement;
  let modelEl!: HTMLSelectElement;
  let cwdEl!: HTMLInputElement;

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
    const prompt = promptEl.value.trim();
    const images = picker.payload();
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
    promptEl.value = "";
    labelEl.value = "";
    setTaskId("");
    picker.clear();
    setShowForm(false);
  };

  return html`
    <aside class="sidebar">
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
          <div class="form">
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
            <textarea ref=${(el: HTMLTextAreaElement) => (promptEl = el)} rows="4"
              placeholder="e.g. List the files here and tell me what this project does."
              onPaste=${(e: ClipboardEvent) => picker.addFromClipboard(e.clipboardData)}></textarea>
            ${AttachStrip(picker)}
            <div class="form-attach">${AttachButton(picker)}<span class="hint">attach or paste image(s)</span></div>
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
                  <div class="item" classList=${() => ({ active: s.id === selectedId() })}
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

function Entry(props: { e: TranscriptEntry }) {
  const e = props.e;
  const head =
    e.kind === "tool_use"
      ? `🔧 ${e.tool ?? "tool"}`
      : e.kind === "user"
        ? "you"
        : e.kind === "assistant"
          ? "agent"
          : e.kind;
  return html`
    <div class="entry ${e.kind}">
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
  let composer!: HTMLTextAreaElement;
  const picker = createImagePicker();

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
    const text = composer.value.trim();
    const images = picker.payload();
    if (!s || (!text && !images.length)) return;
    actions.message(s.id, text, images.length ? images : undefined);
    composer.value = "";
    picker.clear();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendMsg();
    }
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
      if (composer) composer.value = "";
      picker.clear();
    }
  });

  // The conversation shell. Built once while `mode` stays "conv"; the header,
  // sub-agent panel and transcript update through their own leaf accessors,
  // and the composer <textarea> is never recreated — so input survives events.
  const conversation = () => html`
    <header class="conv-head">
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
      return html`<div class="subagents-panel">
        <div class="panel-title clickable" onClick=${() => toggleCollapse(pid)}>
          <span class="caret" classList=${() => ({ collapsed: isCollapsed(pid) })}>▾</span>
          🌿 sub-agent tree (${s.subAgents.length}) —
          ${() => (isCollapsed(pid) ? "click to expand" : "click a node to open it")}
        </div>
        ${() => (isCollapsed(pid) ? "" : SubTreeImpl(s.subAgents, null, s.id))}
      </div>`;
    }}

    <div class="transcript" ref=${(el: HTMLDivElement) => {
      scroller = el;
      // A freshly-mounted transcript (e.g. after switching sessions)
      // starts pinned to the bottom.
      setStickToBottom(true);
      el.addEventListener("scroll", () => setStickToBottom(isAtBottom(el)));
    }}>
      ${() => {
        const s = selected();
        if (!s) return "";
        return s.transcript.length === 0
          ? html`<p class="empty">Waiting for the agent…</p>`
          : s.transcript.map((e: TranscriptEntry) => html`<${Entry} e=${e} />`);
      }}
    </div>

    <div class="composer"
      onDragOver=${(e: DragEvent) => e.preventDefault()}
      onDrop=${(e: DragEvent) => {
        e.preventDefault();
        if (e.dataTransfer?.files?.length) void picker.addFiles(e.dataTransfer.files);
      }}>
      ${AttachStrip(picker)}
      <div class="composer-row">
        ${AttachButton(picker)}
        <textarea ref=${(el: HTMLTextAreaElement) => (composer = el)} rows="2"
          placeholder=${() =>
            selected()?.live
              ? "Message this agent (⌘/Ctrl+Enter to send, paste/drop images)…"
              : "Send to resume this conversation (⌘/Ctrl+Enter)…"}
          onPaste=${(e: ClipboardEvent) => picker.addFromClipboard(e.clipboardData)}
          onKeyDown=${onKey}></textarea>
        <button class="primary" onClick=${sendMsg}>${() => (selected()?.live ? "send" : "resume")}</button>
      </div>
    </div>
  `;

  return html`
    <main class="main">
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
  const tab = (id: "agents" | "pm", label: string) => html`
    <button class="tab" classList=${() => ({ active: view() === id })}
      onClick=${() => setView(id)}>${label}</button>
  `;
  return html`
    <nav class="topnav">
      ${tab("agents", "Agents")}
      ${tab("pm", "Projects")}
    </nav>
  `;
}

function App() {
  return html`<div class="root-shell">
    <${TopNav} />
    ${() =>
      view() === "pm"
        ? html`<${PmView} />`
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
