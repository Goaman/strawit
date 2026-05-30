// Project board backed by Linear (via the Soda Straw gateway).
//
// Mapping:
//   Project        -> Linear project (in team LINEAR_TEAM_ID)
//   Task           -> Linear issue (project set to its Project)
//   task.notes     -> issue description (minus the rave-of-agents:meta footer)
//   task.branch    -> stored in the description's rave-of-agents:meta footer
//   task.cwd       -> stored in the description's rave-of-agents:meta footer
//   status todo/in_progress/done -> Linear states Todo / In Progress / Done
//   status blocked -> a "blocked" label (Linear has no native blocked state)
//
// Linear's MCP exposes no hard delete for issues/projects, so delete is a
// soft-delete: the issue/project is moved to the Canceled state and filtered
// out of the board. Every mutation returns nothing; the API layer re-reads the
// full board (getState) so the client always replaces its store wholesale.

import { callLinear, TEAM_ID } from "./linear-gateway.ts";
import type { PmState, Project, Task, TaskStatus } from "./types.ts";

const STATUSES: TaskStatus[] = ["todo", "in_progress", "blocked", "done"];
const normalizeStatus = (s: unknown): TaskStatus =>
  STATUSES.includes(s as TaskStatus) ? (s as TaskStatus) : "todo";

// ---- status <-> Linear -----------------------------------------------------

// Linear workflow-state name to set for each (non-blocked) app status.
const STATE_NAME: Record<Exclude<TaskStatus, "blocked">, string> = {
  todo: "Todo",
  in_progress: "In Progress",
  done: "Done",
};

const BLOCKED_LABEL = "blocked";

function statusFromIssue(issue: any): TaskStatus {
  const labels: string[] = issue.labels ?? [];
  if (labels.some((l) => String(l).toLowerCase() === BLOCKED_LABEL)) return "blocked";
  switch (issue.statusType) {
    case "started": return "in_progress";
    case "completed": return "done";
    default: return "todo"; // unstarted | backlog | triage
  }
}

// ---- description <-> notes/branch/cwd/worktree -----------------------------

// Match both the current `rave-of-agents:meta` footer and the legacy `strawit:meta`
// one so issues created before the rename still parse.
const META_RE = /\n*<!-- (?:rave-of-agents|strawit):meta\n([\s\S]*?)\n-->\s*$/;

function buildDescription(notes: string, branch: string, cwd: string, worktree: string): string {
  const meta = [
    branch ? `branch: ${branch}` : "",
    cwd ? `cwd: ${cwd}` : "",
    worktree ? `worktree: ${worktree}` : "",
  ].filter(Boolean);
  const body = (notes ?? "").trim();
  if (meta.length === 0) return body;
  return (body ? `${body}\n\n` : "") + `<!-- rave-of-agents:meta\n${meta.join("\n")}\n-->`;
}

function parseDescription(desc: string): { notes: string; branch: string; cwd: string; worktree: string } {
  const d = desc ?? "";
  const m = d.match(META_RE);
  if (!m) return { notes: d.trim(), branch: "", cwd: "", worktree: "" };
  const notes = d.slice(0, m.index).trim();
  let branch = "";
  let cwd = "";
  let worktree = "";
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    if (kv[1] === "branch") branch = kv[2].trim();
    else if (kv[1] === "cwd") cwd = kv[2].trim();
    else if (kv[1] === "worktree") worktree = kv[2].trim();
  }
  return { notes, branch, cwd, worktree };
}

const toMs = (iso: unknown): number => {
  const t = Date.parse(String(iso));
  return Number.isNaN(t) ? 0 : t;
};

function mapProject(p: any): Project {
  return {
    id: String(p.id),
    name: p.name ?? "",
    description: p.description ?? "",
    url: p.url ?? "",
    createdAt: toMs(p.createdAt),
    updatedAt: toMs(p.updatedAt),
  };
}

function mapIssue(issue: any): Task {
  const { notes, branch, cwd, worktree } = parseDescription(issue.description ?? "");
  return {
    id: String(issue.id),
    projectId: String(issue.projectId ?? ""),
    title: issue.title ?? "",
    notes,
    status: statusFromIssue(issue),
    branch,
    cwd,
    worktree,
    url: issue.url ?? "",
    createdAt: toMs(issue.createdAt),
    updatedAt: toMs(issue.updatedAt),
  };
}

// ---- "blocked" label (lazily ensured) --------------------------------------

let blockedLabelReady = false;
async function ensureBlockedLabel(): Promise<void> {
  if (blockedLabelReady) return;
  const res = await callLinear(
    "list_issue_labels",
    { team: TEAM_ID, limit: 250 },
    "Rave of Agents board: check for the 'blocked' label",
  );
  const exists = (res.labels ?? []).some(
    (l: any) => String(l.name).toLowerCase() === BLOCKED_LABEL,
  );
  if (!exists) {
    await callLinear(
      "create_issue_label",
      { name: BLOCKED_LABEL, color: "#e5484d", teamId: TEAM_ID },
      "Rave of Agents board: create the 'blocked' label",
    );
  }
  blockedLabelReady = true;
}

// ---- board read ------------------------------------------------------------

export async function getState(): Promise<PmState> {
  const [projRes, issRes] = await Promise.all([
    callLinear("list_projects", { team: TEAM_ID, limit: 50 }, "Rave of Agents board: load projects"),
    callLinear("list_issues", { team: TEAM_ID, limit: 250 }, "Rave of Agents board: load tasks"),
  ]);

  const projects = (projRes.projects ?? [])
    .filter((p: any) => p.status?.type !== "canceled")
    .map(mapProject)
    .sort((a: Project, b: Project) => a.createdAt - b.createdAt);

  const projectIds = new Set(projects.map((p: Project) => p.id));

  const tasks = (issRes.issues ?? [])
    .filter((i: any) => i.statusType !== "canceled" && projectIds.has(String(i.projectId ?? "")))
    .map(mapIssue)
    .sort((a: Task, b: Task) => a.createdAt - b.createdAt);

  return { projects, tasks };
}

// ---- Projects --------------------------------------------------------------

export async function createProject(input: { name?: string; description?: string }): Promise<Project> {
  const p = await callLinear(
    "save_project",
    {
      name: (input.name ?? "").trim() || "Untitled project",
      description: (input.description ?? "").trim(),
      addTeams: [TEAM_ID],
    },
    "Rave of Agents board: create a project",
  );
  return mapProject(p);
}

export async function updateProject(
  pid: string,
  patch: { name?: string; description?: string },
): Promise<Project> {
  const args: Record<string, unknown> = { id: pid };
  if (patch.name !== undefined && patch.name.trim()) args.name = patch.name.trim();
  if (patch.description !== undefined) args.description = patch.description;
  const p = await callLinear("save_project", args, "Rave of Agents board: update a project");
  return mapProject(p);
}

export async function deleteProject(pid: string): Promise<boolean> {
  // Soft delete: move the project to the Canceled state (no hard delete in the API).
  await callLinear(
    "save_project",
    { id: pid, state: "canceled" },
    "Rave of Agents board: delete (cancel) a project",
  );
  return true;
}

// ---- Tasks -----------------------------------------------------------------

export async function createTask(input: {
  projectId?: string;
  title?: string;
  notes?: string;
  status?: TaskStatus;
  branch?: string;
  cwd?: string;
  worktree?: string;
}): Promise<Task> {
  const projectId = (input.projectId ?? "").trim();
  if (!projectId) throw new Error("missing projectId");
  const status = normalizeStatus(input.status);
  const branch = (input.branch ?? "").trim();
  const cwd = (input.cwd ?? "").trim();
  const worktree = (input.worktree ?? "").trim();

  const args: Record<string, unknown> = {
    title: (input.title ?? "").trim() || "Untitled task",
    team: TEAM_ID,
    project: projectId,
    description: buildDescription(input.notes ?? "", branch, cwd, worktree),
  };

  if (status === "blocked") {
    await ensureBlockedLabel();
    args.state = STATE_NAME.todo; // base state under the blocked label
    args.labels = [BLOCKED_LABEL];
  } else {
    args.state = STATE_NAME[status];
  }

  const issue = await callLinear("save_issue", args, "Rave of Agents board: create a task");
  return mapIssue(issue);
}

export async function updateTask(
  tid: string,
  patch: {
    title?: string;
    notes?: string;
    status?: TaskStatus;
    branch?: string;
    cwd?: string;
    worktree?: string;
  },
): Promise<Task> {
  const args: Record<string, unknown> = { id: tid };

  if (patch.title !== undefined && patch.title.trim()) args.title = patch.title.trim();

  // Rebuild the description (and meta footer) whenever any of its parts change.
  // The editor sends notes+branch+cwd+worktree together; the quick status
  // dropdown sends status only, so we don't touch the description in that case.
  const touchesDesc =
    patch.notes !== undefined ||
    patch.branch !== undefined ||
    patch.cwd !== undefined ||
    patch.worktree !== undefined;

  // A status change needs the current label set so we can add/remove "blocked"
  // without clobbering other labels (save_issue replaces the whole label set).
  const needsCurrent = touchesDesc || patch.status !== undefined;
  const current = needsCurrent
    ? await callLinear("get_issue", { id: tid }, "Rave of Agents board: read a task before update")
    : null;

  if (touchesDesc) {
    const cur = parseDescription(current?.description ?? "");
    const notes = patch.notes !== undefined ? patch.notes : cur.notes;
    const branch = patch.branch !== undefined ? patch.branch.trim() : cur.branch;
    const cwd = patch.cwd !== undefined ? patch.cwd.trim() : cur.cwd;
    const worktree = patch.worktree !== undefined ? patch.worktree.trim() : cur.worktree;
    args.description = buildDescription(notes, branch, cwd, worktree);
  }

  if (patch.status !== undefined) {
    const status = normalizeStatus(patch.status);
    const nonBlocked = (current?.labels ?? []).filter(
      (l: any) => String(l).toLowerCase() !== BLOCKED_LABEL,
    );
    if (status === "blocked") {
      await ensureBlockedLabel();
      args.labels = [...nonBlocked, BLOCKED_LABEL]; // keep current state, add the label
    } else {
      args.labels = nonBlocked; // drop the blocked label, set the real state
      args.state = STATE_NAME[status];
    }
  }

  const issue = await callLinear("save_issue", args, "Rave of Agents board: update a task");
  return mapIssue(issue);
}

export async function deleteTask(tid: string): Promise<boolean> {
  // Soft delete: move the issue to the Canceled state (no hard delete in the API).
  await callLinear(
    "save_issue",
    { id: tid, state: "Canceled" },
    "Rave of Agents board: delete (cancel) a task",
  );
  return true;
}

// ---- session <-> task ------------------------------------------------------

// Project used to file auto-created session tasks under when the board is
// empty and we have to create one. Normally tasks land in the existing main
// project, so this is only a last-resort fallback.
const SESSIONS_PROJECT_NAME = "Agent Sessions";

// Resolve the task a new session belongs to. A picked task is returned as-is
// (no Linear round-trip); with none picked we auto-create one under the main
// project — the first/primary project on the board — so the session is still
// tracked without spinning up a separate project. Only when the board has no
// projects at all do we create a fallback project to hang the task off of.
export async function ensureSessionTask(input: {
  taskId?: string | null;
  title?: string;
  notes?: string;
  cwd?: string;
}): Promise<string> {
  const picked = (input.taskId ?? "").trim();
  if (picked) return picked;

  // getState() returns projects sorted by createdAt ascending, so the first
  // entry is the oldest — the user's main project.
  const { projects } = await getState();
  const project =
    projects[0] ??
    (await createProject({
      name: SESSIONS_PROJECT_NAME,
      description: "Tasks auto-created for agent sessions launched without picking one.",
    }));

  const task = await createTask({
    projectId: project.id,
    title: (input.title ?? "").trim() || "Untitled session",
    notes: input.notes,
    cwd: input.cwd,
    status: "in_progress",
  });
  return task.id;
}
