// Creates an isolated git worktree for a task so an agent can work on it
// without touching your live checkout. Backed by the `goa project:worktree:add`
// CLI (the same tool used to manage worktrees by hand), which branches off
// master and parks the tree under ~/.goapower/worktrees/<project>/<branch>.
//
// Used by the project board's "⎇ agent" button: the API resolves/creates the
// worktree, then the client starts an agent session whose cwd is that worktree.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// Prefer the user's installed goa; fall back to PATH resolution.
const GOA = existsSync(join(homedir(), "bin", "goa")) ? join(homedir(), "bin", "goa") : "goa";
const WORKTREE_HOME = join(homedir(), ".goapower", "worktrees");

interface RunResult {
  code: number;
  out: string;
}

function run(bin: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env: process.env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => resolve({ code: -1, out: out + String(e) }));
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

// Root of the *main* worktree of the repo containing `cwd` (not a linked
// worktree), or null if `cwd` isn't a git repo. We need the main checkout
// because its directory name is the goa project name — `goa project:worktree:add`
// is given that name. `git worktree list` always lists the main worktree first.
async function mainWorktreeRoot(cwd: string): Promise<string | null> {
  const r = await run("git", ["worktree", "list", "--porcelain"], cwd);
  if (r.code !== 0) return null;
  const line = r.out.split("\n").find((l) => l.startsWith("worktree "));
  return line ? line.slice("worktree ".length).trim() || null : null;
}

// A filesystem/git-safe branch name derived from a task, e.g. "agent-fix-login-a1b2c3".
function deriveBranch(task: { id: string; title: string }): string {
  const slug =
    (task.title || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task";
  const short = (task.id || "").replace(/[^a-zA-Z0-9]/g, "").slice(-6).toLowerCase() || "wt";
  return `agent-${slug}-${short}`;
}

export interface TaskWorktree {
  path: string;
  branch: string;
  project: string;
  created: boolean;
}

// Ensure a dedicated worktree exists for `task` and return where it lives.
// Idempotent: if the worktree already exists it is reused (so clicking twice
// reattaches the agent to the same tree instead of erroring).
export async function ensureTaskWorktree(task: {
  id: string;
  title: string;
  branch?: string;
  cwd?: string;
}): Promise<TaskWorktree> {
  const base = task.cwd?.trim() || process.cwd();
  const root =
    (await mainWorktreeRoot(base)) || (await mainWorktreeRoot(process.cwd())) || process.cwd();
  const project = basename(root);
  const branch = task.branch?.trim() || deriveBranch(task);

  const expected = join(WORKTREE_HOME, project, branch);
  if (existsSync(expected)) return { path: expected, branch, project, created: false };

  // `--hook false` skips the slow afterWorktreeInit (bun i; module:install) so the
  // request returns promptly; the agent can install deps itself if it needs them.
  const res = await run(GOA, ["project:worktree:add", project, branch, "--hook", "false"], root);
  const m = res.out.match(/worktree for branch \S+ at (\S+)/) || res.out.match(/\bat (\/\S+)/);
  const path = (m && m[1]) || expected;

  if (!existsSync(path)) {
    throw new Error(
      `failed to create worktree for "${project}/${branch}" (goa exit ${res.code}): ` +
        res.out.trim().slice(-400),
    );
  }
  return { path, branch, project, created: true };
}
