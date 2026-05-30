// Project board backed by Linear (via the Soda Straw gateway).
//
// Mapping:
//   Project        -> Linear project (in team LINEAR_TEAM_ID)
//   Task           -> Linear issue (project set to its Project)
//   task.notes     -> issue description (minus the strawit:meta footer)
//   task.branch    -> stored in the description's strawit:meta footer
//   task.cwd       -> stored in the description's strawit:meta footer
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

// ---- description <-> notes/branch/cwd --------------------------------------

const META_RE = /\n*<!-- strawit:meta\n([\s\S]*?)\n-->\s*$/;

function buildDescription(notes: string, branch: string, cwd: string): string {
  const meta = [
    branch ? `branch: ${branch}` : "",
    cwd ? `cwd: ${cwd}` : "",
  ].filter(Boolean);
  const body = (notes ?? "").trim();
  if (meta.length === 0) return body;
  return (body ? `${body}\n\n` : "") + `<!-- strawit:meta\n${meta.join("\n")}\n-->`;
}

function parseDescription(desc: string): { notes: string; branch: string; cwd: string } {
  const d = desc ?? "";
  const m = d.match(META_RE);
  if (!m) return { notes: d.trim(), branch: "", cwd: "" };
  const notes = d.slice(0, m.index).trim();
  let branch = "";
  let cwd = "";
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    if (kv[1] === "branch") branch = kv[2].trim();
    else if (kv[1] === "cwd") cwd = kv[2].trim();
  }
  return { notes, branch, cwd };
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
  const { notes, branch, cwd } = parseDescription(issue.description ?? "");
  return {
    id: String(issue.id),
    projectId: String(issue.projectId ?? ""),
    title: issue.title ?? "",
    notes,
    status: statusFromIssue(issue),
    branch,
    cwd,
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
    "Strawit board: check for the 'blocked' label",
  );
  const exists = (res.labels ?? []).some(
    (l: any) => String(l.name).toLowerCase() === BLOCKED_LABEL,
  );
  if (!exists) {
    await callLinear(
      "create_issue_label",
      { name: BLOCKED_LABEL, color: "#e5484d", teamId: TEAM_ID },
      "Strawit board: create the 'blocked' label",
    );
  }
  blockedLabelReady = true;
}

// ---- board read ------------------------------------------------------------

export async function getState(): Promise<PmState> {
  const [projRes, issRes] = await Promise.all([
    callLinear("list_projects", { team: TEAM_ID, limit: 50 }, "Strawit board: load projects"),
    callLinear("list_issues", { team: TEAM_ID, limit: 250 }, "Strawit board: load tasks"),
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
    "Strawit board: create a project",
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
  const p = await callLinear("save_project", args, "Strawit board: update a project");
  return mapProject(p);
}

export async function deleteProject(pid: string): Promise<boolean> {
  // Soft delete: move the project to the Canceled state (no hard delete in the API).
  await callLinear(
    "save_project",
    { id: pid, state: "canceled" },
    "Strawit board: delete (cancel) a project",
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
}): Promise<Task> {
  const projectId = (input.projectId ?? "").trim();
  if (!projectId) throw new Error("missing projectId");
  const status = normalizeStatus(input.status);
  const branch = (input.branch ?? "").trim();
  const cwd = (input.cwd ?? "").trim();

  const args: Record<string, unknown> = {
    title: (input.title ?? "").trim() || "Untitled task",
    team: TEAM_ID,
    project: projectId,
    description: buildDescription(input.notes ?? "", branch, cwd),
  };

  if (status === "blocked") {
    await ensureBlockedLabel();
    args.state = STATE_NAME.todo; // base state under the blocked label
    args.labels = [BLOCKED_LABEL];
  } else {
    args.state = STATE_NAME[status];
  }

  const issue = await callLinear("save_issue", args, "Strawit board: create a task");
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
  },
): Promise<Task> {
  const args: Record<string, unknown> = { id: tid };

  if (patch.title !== undefined && patch.title.trim()) args.title = patch.title.trim();

  // Rebuild the description (and meta footer) whenever any of its parts change.
  // The editor sends notes+branch+cwd together; the quick status dropdown sends
  // status only, so we don't touch the description in that case.
  const touchesDesc =
    patch.notes !== undefined || patch.branch !== undefined || patch.cwd !== undefined;

  // A status change needs the current label set so we can add/remove "blocked"
  // without clobbering other labels (save_issue replaces the whole label set).
  const needsCurrent = touchesDesc || patch.status !== undefined;
  const current = needsCurrent
    ? await callLinear("get_issue", { id: tid }, "Strawit board: read a task before update")
    : null;

  if (touchesDesc) {
    const cur = parseDescription(current?.description ?? "");
    const notes = patch.notes !== undefined ? patch.notes : cur.notes;
    const branch = patch.branch !== undefined ? patch.branch.trim() : cur.branch;
    const cwd = patch.cwd !== undefined ? patch.cwd.trim() : cur.cwd;
    args.description = buildDescription(notes, branch, cwd);
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

  const issue = await callLinear("save_issue", args, "Strawit board: update a task");
  return mapIssue(issue);
}

export async function deleteTask(tid: string): Promise<boolean> {
  // Soft delete: move the issue to the Canceled state (no hard delete in the API).
  await callLinear(
    "save_issue",
    { id: tid, state: "Canceled" },
    "Strawit board: delete (cancel) a task",
  );
  return true;
}
