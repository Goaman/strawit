// Project board UI (SolidJS via solid-js/html). Talks to the /api/pm REST
// endpoints, which are backed by Linear through the Soda Straw gateway; every
// mutation returns the full board, which we drop straight into the store. CRUD
// for projects and tasks; tasks carry an optional branch + cwd, and can launch
// an agent in that cwd straight into the existing console. Because requests now
// hit Linear over the network, failures surface in a dismissible banner.

import html from "solid-js/html";
import { createSignal, onMount } from "solid-js";
import { confirmDialog } from "./dialog.ts";
import {
  actions,
  board as pmState,
  selectSession,
  sessions,
  setBoard as setPmState,
  setView,
} from "./store.ts";
import type { Project, SessionSnapshot, Task, TaskStatus } from "../types.ts";

const API = "/api/pm";

// The board itself lives in the shared store (so the agent console's new-agent
// form can read tasks too). `pmState`/`setPmState` are the store's board signal.
//
// Remember the last project the user opened across reloads via a single
// localStorage key; guarded so it degrades gracefully where storage is
// unavailable (private mode, SSR, etc.).
const SELECTED_PROJECT_KEY = "pm.selectedProjectId";

function readStoredProjectId(): string | null {
  try {
    return localStorage.getItem(SELECTED_PROJECT_KEY);
  } catch {
    return null;
  }
}

const [selectedProjectId, setSelectedProjectIdRaw] = createSignal<string | null>(
  readStoredProjectId(),
);

// Persisting wrapper: keep localStorage in sync with the selected project so a
// reload lands the user back on the same board.
function setSelectedProjectId(id: string | null) {
  setSelectedProjectIdRaw(id);
  try {
    if (id) localStorage.setItem(SELECTED_PROJECT_KEY, id);
    else localStorage.removeItem(SELECTED_PROJECT_KEY);
  } catch {
    // ignore storage failures
  }
}
const [showProjectForm, setShowProjectForm] = createSignal(false);
const [editingProject, setEditingProject] = createSignal(false);
const [showTaskForm, setShowTaskForm] = createSignal(false);
const [editingTaskId, setEditingTaskId] = createSignal<string | null>(null);
const [pmError, setPmError] = createSignal<string | null>(null);
const [pmBusy, setPmBusy] = createSignal(false);

const TASK_STATUS: [TaskStatus, string][] = [
  ["todo", "To do"],
  ["in_progress", "In progress"],
  ["blocked", "Blocked"],
  ["done", "Done"],
];
const STATUS_LABEL = Object.fromEntries(TASK_STATUS) as Record<TaskStatus, string>;

async function errorOf(r: Response, fallback: string): Promise<string> {
  const data = await r.json().catch(() => null);
  return (data && data.error) || `${fallback} (${r.status})`;
}

async function refresh() {
  setPmBusy(true);
  try {
    const r = await fetch(API);
    if (r.ok) {
      setPmState(await r.json());
      setPmError(null);
      // Drop a restored selection that no longer points at a real project.
      const current = selectedProjectId();
      if (current && !pmState().projects.some((p) => p.id === current)) {
        setSelectedProjectId(null);
      }
    } else {
      setPmError(await errorOf(r, "Failed to load board"));
    }
  } catch (e) {
    setPmError(String(e));
  } finally {
    setPmBusy(false);
  }
}

async function mutate(path: string, method: string, payload?: unknown): Promise<boolean> {
  setPmBusy(true);
  try {
    const r = await fetch(API + path, {
      method,
      headers: payload ? { "content-type": "application/json" } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
    });
    if (r.ok) {
      setPmState(await r.json());
      setPmError(null);
      return true;
    }
    setPmError(await errorOf(r, "Request failed"));
    return false;
  } catch (e) {
    setPmError(String(e));
    return false;
  } finally {
    setPmBusy(false);
  }
}

const createProject = (p: { name: string; description: string }) =>
  mutate("/projects", "POST", p);
const updateProject = (id: string, p: Partial<Project>) =>
  mutate(`/projects/${id}`, "PATCH", p);
const deleteProject = (id: string) => mutate(`/projects/${id}`, "DELETE");
const createTask = (t: Partial<Task>) => mutate("/tasks", "POST", t);
const updateTask = (id: string, t: Partial<Task>) => mutate(`/tasks/${id}`, "PATCH", t);
const deleteTask = (id: string) => mutate(`/tasks/${id}`, "DELETE");

function selectedProject(): Project | undefined {
  const id = selectedProjectId();
  return pmState().projects.find((p) => p.id === id);
}
function tasksFor(projectId: string): Task[] {
  return pmState().tasks.filter((t) => t.projectId === projectId);
}

// ---- forms -------------------------------------------------------------

function ProjectEditor(opts: { project?: Project; onClose: () => void }) {
  let nameEl!: HTMLInputElement;
  let descEl!: HTMLTextAreaElement;
  const p = opts.project;
  const submit = async () => {
    const name = nameEl.value.trim();
    if (!name && !p) return;
    if (p) await updateProject(p.id, { name, description: descEl.value });
    else {
      await createProject({ name, description: descEl.value });
      // Select the newest project so the user lands on it.
      const list = pmState().projects;
      if (list.length) setSelectedProjectId(list[list.length - 1].id);
    }
    opts.onClose();
  };
  return html`
    <div class="pm-form">
      <label>project name</label>
      <input ref=${(e: HTMLInputElement) => (nameEl = e)} value=${p?.name ?? ""}
        placeholder="e.g. Billing rewrite" />
      <label>description</label>
      <textarea ref=${(e: HTMLTextAreaElement) => (descEl = e)} rows="2"
        placeholder="what is this project about?">${p?.description ?? ""}</textarea>
      <div class="editor-actions">
        <button class="primary" onClick=${submit}>${p ? "save" : "create project"}</button>
        <button onClick=${opts.onClose}>cancel</button>
      </div>
    </div>
  `;
}

function TaskEditor(opts: { task?: Task; projectId: string; onClose: () => void }) {
  let titleEl!: HTMLInputElement;
  let notesEl!: HTMLTextAreaElement;
  let branchEl!: HTMLInputElement;
  let cwdEl!: HTMLInputElement;
  let worktreeEl!: HTMLInputElement;
  let statusEl!: HTMLSelectElement;
  const t = opts.task;
  const submit = async () => {
    const title = titleEl.value.trim();
    if (!title) return;
    const payload = {
      title,
      notes: notesEl.value,
      branch: branchEl.value.trim(),
      cwd: cwdEl.value.trim(),
      worktree: worktreeEl.value.trim(),
      status: statusEl.value as TaskStatus,
    };
    if (t) await updateTask(t.id, payload);
    else await createTask({ ...payload, projectId: opts.projectId });
    opts.onClose();
  };
  return html`
    <div class="pm-form task-editor">
      <label>title</label>
      <input ref=${(e: HTMLInputElement) => (titleEl = e)} value=${t?.title ?? ""}
        placeholder="what needs doing?" />
      <label>notes</label>
      <textarea ref=${(e: HTMLTextAreaElement) => (notesEl = e)} rows="2"
        placeholder="details (optional)">${t?.notes ?? ""}</textarea>
      <div class="row2">
        <div>
          <label>branch</label>
          <input ref=${(e: HTMLInputElement) => (branchEl = e)} value=${t?.branch ?? ""}
            placeholder="feature/x (optional)" />
        </div>
        <div>
          <label>cwd</label>
          <input ref=${(e: HTMLInputElement) => (cwdEl = e)} value=${t?.cwd ?? ""}
            placeholder="working dir (optional)" />
        </div>
      </div>
      <div class="row2">
        <div>
          <label>worktree</label>
          <input ref=${(e: HTMLInputElement) => (worktreeEl = e)} value=${t?.worktree ?? ""}
            placeholder="goa project:worktree:add <name>" />
        </div>
        <div>
          <label>status</label>
          <select ref=${(e: HTMLSelectElement) => (statusEl = e)}>
            ${TASK_STATUS.map(
              ([v, l]) =>
                html`<option value=${v} selected=${(t?.status ?? "todo") === v}>${l}</option>`,
            )}
          </select>
        </div>
        <div class="editor-actions">
          <button class="primary" onClick=${submit}>${t ? "save" : "add task"}</button>
          <button onClick=${opts.onClose}>cancel</button>
        </div>
      </div>
    </div>
  `;
}

// ---- task card ---------------------------------------------------------

function launchAgentFor(task: Task) {
  const lines = [
    `Work on this task: ${task.title}`,
    task.notes ? `\nNotes:\n${task.notes}` : "",
    task.branch ? `\nGit branch: ${task.branch}` : "",
    task.worktree ? `\nGit worktree: ${task.worktree}` : "",
  ].filter(Boolean);
  // Every session is tied to its task (taskId), so the agents view can group
  // sessions by task and a task can own many of them.
  actions.create({
    label: task.title,
    prompt: lines.join("\n"),
    cwd: task.cwd || undefined,
    taskId: task.id,
  });
  setView("agents");
}

// Create a dedicated git worktree for the task (server-side), then launch an
// agent whose cwd is that worktree — so it works in isolation from your
// checkout. Records the worktree name on the task and marks it in-progress.
async function launchAgentInWorktree(task: Task) {
  setPmBusy(true);
  try {
    const r = await fetch(`${API}/tasks/${task.id}/worktree`, { method: "POST" });
    if (!r.ok) {
      setPmError(await errorOf(r, "Failed to create worktree"));
      return;
    }
    const { path, branch } = (await r.json()) as { path: string; branch: string };
    const lines = [
      `Work on this task: ${task.title}`,
      task.notes ? `\n${task.notes}` : "",
      `\nYou are in a dedicated git worktree at ${path} on branch \`${branch}\`. Do the work and commit it here.`,
    ].filter(Boolean);
    // Link the session to its task and run it inside the worktree.
    actions.create({ label: task.title, prompt: lines.join("\n"), cwd: path, taskId: task.id });
    setPmError(null);
    setView("agents");
    // Best-effort: record the worktree name (and its branch) and flag the task started.
    void updateTask(task.id, { status: "in_progress", branch, worktree: branch });
  } catch (e) {
    setPmError(String(e));
  } finally {
    setPmBusy(false);
  }
}

// Sessions currently linked to a task (a task can own many).
function sessionsForTask(taskId: string): SessionSnapshot[] {
  return sessions().filter((s) => s.taskId === taskId);
}

function TaskCard(task: Task) {
  return html`
    <div class="task-card" data-component="TaskCard">
      ${() =>
        editingTaskId() === task.id
          ? TaskEditor({ task, projectId: task.projectId, onClose: () => setEditingTaskId(null) })
          : html`
              <div class="task-head">
                <span class="tstat ${task.status}">${STATUS_LABEL[task.status]}</span>
                <span class="task-title">${task.title}</span>
                ${task.url
                  ? html`<a class="issue-id" href=${task.url} target="_blank"
                      title="open in Linear">${task.id} ↗</a>`
                  : ""}
              </div>
              ${task.notes ? html`<div class="task-notes">${task.notes}</div>` : ""}
              ${task.branch || task.cwd || task.worktree
                ? html`<div class="task-meta">
                    ${task.branch ? html`<span class="chip">⎇ ${task.branch}</span>` : ""}
                    ${task.worktree ? html`<span class="chip">🌳 ${task.worktree}</span>` : ""}
                    ${task.cwd ? html`<span class="chip">📁 ${task.cwd}</span>` : ""}
                  </div>`
                : ""}
              ${() => {
                const list = sessionsForTask(task.id);
                if (!list.length) return "";
                return html`<div class="task-sessions">
                  <span class="task-sessions-head">${list.length} session(s)</span>
                  ${list.map((s: SessionSnapshot) => html`
                    <button class="task-session" title="open this session"
                      onClick=${() => {
                        selectSession(s.id);
                        setView("agents");
                      }}>
                      <span class="badge ${s.status}">${s.status}</span>
                      <span class="task-session-label">${s.label}</span>
                    </button>
                  `)}
                </div>`;
              }}
              <div class="task-actions">
                <select onChange=${(e: Event) =>
                  updateTask(task.id, { status: (e.target as HTMLSelectElement).value as TaskStatus })}>
                  ${TASK_STATUS.map(
                    ([v, l]) => html`<option value=${v} selected=${task.status === v}>${l}</option>`,
                  )}
                </select>
                <button onClick=${() => setEditingTaskId(task.id)}>edit</button>
                <button title="launch a console agent in this task's cwd"
                  onClick=${() => launchAgentFor(task)}>▶ agent</button>
                <button title="create a dedicated git worktree for this task and launch an agent in it"
                  onClick=${() => launchAgentInWorktree(task)}>⎇ agent</button>
                <button class="danger"
                  onClick=${async () => {
                    if (
                      await confirmDialog({
                        title: "Delete task",
                        message: `Delete task "${task.title}"?`,
                        confirmLabel: "Delete",
                        danger: true,
                      })
                    )
                      deleteTask(task.id);
                  }}>delete</button>
              </div>
            `}
    </div>
  `;
}

// ---- panes -------------------------------------------------------------

function ProjectList() {
  return html`
    <aside class="pm-sidebar" data-component="ProjectList">
      <div class="pm-side-head">
        <strong>Projects</strong>
        <button class="primary" onClick=${() => setShowProjectForm((v) => !v)}>
          ${() => (showProjectForm() ? "✕" : "+ new")}
        </button>
      </div>
      ${() =>
        showProjectForm()
          ? ProjectEditor({ onClose: () => setShowProjectForm(false) })
          : ""}
      <div class="pm-project-list">
        ${() =>
          pmState().projects.length === 0
            ? html`<p class="empty">No projects yet.</p>`
            : pmState().projects.map((p: Project) => {
                const count = () => tasksFor(p.id).length;
                const done = () => tasksFor(p.id).filter((t) => t.status === "done").length;
                return html`
                  <div class="pm-project" classList=${() => ({ active: p.id === selectedProjectId() })}
                    onClick=${() => {
                      setSelectedProjectId(p.id);
                      setEditingProject(false);
                    }}>
                    <span class="name">${p.name}</span>
                    <span class="count">${done}/${count} done</span>
                  </div>
                `;
              })}
      </div>
    </aside>
  `;
}

function TaskBoard() {
  return html`
    <main class="pm-main" data-component="TaskBoard">
      ${() => {
        const p = selectedProject();
        if (!p) return html`<div class="placeholder">Select or create a project.</div>`;

        const tasks = () => tasksFor(p.id);
        return html`
          <header class="pm-head">
            ${() =>
              editingProject()
                ? ProjectEditor({ project: p, onClose: () => setEditingProject(false) })
                : html`
                    <div class="pm-head-info">
                      <div class="pm-head-title">
                        <strong>${p.name}</strong>
                        ${p.url
                          ? html`<a class="linear-link" href=${p.url} target="_blank"
                              title="open in Linear">Linear ↗</a>`
                          : ""}
                      </div>
                      ${p.description ? html`<p class="pm-desc">${p.description}</p>` : ""}
                    </div>
                    <div class="head-actions">
                      <button onClick=${() => setEditingProject(true)}>edit</button>
                      <button class="danger"
                        onClick=${async () => {
                          if (
                            await confirmDialog({
                              title: "Delete project",
                              message: `Delete project "${p.name}" and all its tasks?`,
                              confirmLabel: "Delete",
                              danger: true,
                            })
                          ) {
                            deleteProject(p.id);
                            setSelectedProjectId(null);
                          }
                        }}>delete</button>
                    </div>
                  `}
          </header>

          <div class="pm-tasks">
            <div class="pm-tasks-head">
              <span>${() => tasks().length} task(s)</span>
              <button class="primary" onClick=${() => setShowTaskForm((v) => !v)}>
                ${() => (showTaskForm() ? "✕ cancel" : "+ add task")}
              </button>
            </div>
            ${() =>
              showTaskForm()
                ? TaskEditor({ projectId: p.id, onClose: () => setShowTaskForm(false) })
                : ""}
            ${() =>
              tasks().length === 0
                ? html`<p class="empty">No tasks yet. Add one above.</p>`
                : tasks().map((t: Task) => TaskCard(t))}
          </div>
        `;
      }}
    </main>
  `;
}

export function PmView() {
  onMount(refresh);
  return html`
    <div class="pm-wrap" data-component="ProjectBoard">
      ${() =>
        pmError()
          ? html`<div class="pm-banner error">
              <span>⚠ ${pmError()}</span>
              <span class="banner-actions">
                <button onClick=${() => refresh()}>retry</button>
                <button onClick=${() => setPmError(null)}>dismiss</button>
              </span>
            </div>`
          : ""}
      <div class="pm-app" classList=${() => ({ busy: pmBusy() })}>
        <${ProjectList} /><${TaskBoard} />
      </div>
    </div>
  `;
}
