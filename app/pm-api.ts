// Tiny REST API for the project board. Returns a Response for any /api/pm*
// route, or null so the caller can fall through to static serving.
//
// The board is backed by Linear through the Soda Straw gateway (see
// pm-store.ts), so every handler is async and may fail on a network/auth/Linear
// error — those surface as 502 with a message the client can show. Mutating
// endpoints re-read and return the full {projects, tasks} board so the client
// replaces its store wholesale.

import {
  createProject,
  createTask,
  deleteProject,
  deleteTask,
  getState,
  updateProject,
  updateTask,
} from "./pm-store.ts";
import { gatewayConfigured, gatewayConfigError } from "./linear-gateway.ts";
import { ensureTaskWorktree } from "./worktree.ts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

async function body(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

export async function handlePmRequest(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (!path.startsWith("/api/pm")) return null;

  if (!gatewayConfigured()) return json({ error: gatewayConfigError() }, 503);

  const method = req.method.toUpperCase();
  // Segments after /api/pm: e.g. ["projects", "<id>"] or ["tasks", "<id>"].
  const seg = path.slice("/api/pm".length).split("/").filter(Boolean);

  try {
    // GET /api/pm — full board
    if (seg.length === 0) {
      if (method === "GET") return json(await getState());
      return json({ error: "method not allowed" }, 405);
    }

    const [collection, resourceId] = seg;

    if (collection === "projects") {
      if (!resourceId) {
        if (method === "POST") {
          await createProject(await body(req));
          return json(await getState(), 201);
        }
        return json({ error: "method not allowed" }, 405);
      }
      if (method === "PATCH") {
        await updateProject(resourceId, await body(req));
        return json(await getState());
      }
      if (method === "DELETE") {
        await deleteProject(resourceId);
        return json(await getState());
      }
      return json({ error: "method not allowed" }, 405);
    }

    if (collection === "tasks") {
      // POST /api/pm/tasks/<id>/worktree — ensure an isolated git worktree for
      // the task and return where it lives, so the client can start an agent
      // session whose cwd is that worktree.
      if (resourceId && seg[2] === "worktree") {
        if (method !== "POST") return json({ error: "method not allowed" }, 405);
        const { tasks } = await getState();
        const task = tasks.find((t) => t.id === resourceId);
        if (!task) return json({ error: "task not found" }, 404);
        try {
          const wt = await ensureTaskWorktree(task);
          return json({ path: wt.path, branch: wt.branch, project: wt.project });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 502);
        }
      }
      if (!resourceId) {
        if (method === "POST") {
          const payload = await body(req);
          if (!payload?.projectId) return json({ error: "missing projectId" }, 400);
          await createTask(payload);
          return json(await getState(), 201);
        }
        return json({ error: "method not allowed" }, 405);
      }
      if (method === "PATCH") {
        await updateTask(resourceId, await body(req));
        return json(await getState());
      }
      if (method === "DELETE") {
        await deleteTask(resourceId);
        return json(await getState());
      }
      return json({ error: "method not allowed" }, 405);
    }

    return json({ error: "not found" }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: `Linear request failed: ${message}` }, 502);
  }
}
