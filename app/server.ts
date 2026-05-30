// Bun server: builds the SolidJS client, serves it, and exposes a websocket hub
// that streams agent session state and relays user messages to live agents.
//
// Exported as startServer() so the TUI can embed it; runs automatically when
// this file is executed directly.

import { AgentManager, type ManagerEvent } from "./agent-manager.ts";
import type { ClientMessage, ServerMessage } from "./types.ts";
import { handlePmRequest } from "./pm-api.ts";
import { join } from "node:path";

const ROOT = import.meta.dir;
const PUBLIC = join(ROOT, "public");

const CONTENT_TYPE: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  json: "application/json; charset=utf-8",
};

export async function startServer(opts: { port?: number; quiet?: boolean } = {}) {
  const port = opts.port ?? Number(process.env.PORT || 4317);

  // Build the client bundle (Solid via solid-js/html — no JSX/babel step).
  const build = await Bun.build({
    entrypoints: [join(ROOT, "client", "main.ts")],
    outdir: PUBLIC,
    naming: "client.js",
    minify: false,
    target: "browser",
  });
  if (!build.success) {
    console.error("Client build failed:");
    for (const m of build.logs) console.error(m);
    throw new Error("client build failed");
  }

  const clients = new Set<Bun.ServerWebSocket<unknown>>();
  function broadcast(msg: ServerMessage) {
    const data = JSON.stringify(msg);
    for (const ws of clients) {
      try {
        ws.send(data);
      } catch {
        /* dropped client */
      }
    }
  }

  // The manager emits lifecycle/transcript/tree events; forward them verbatim.
  const manager = await AgentManager.start((e: ManagerEvent) => broadcast(e as ServerMessage));

  const server = Bun.serve({
    port,
    async fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        if (srv.upgrade(req)) return; // upgraded
        return new Response("expected websocket", { status: 400 });
      }

      // Project-board REST API (returns null for non-PM routes).
      const pm = await handlePmRequest(req, url);
      if (pm) return pm;

      // Static files from public/, with index.html at root.
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = Bun.file(join(PUBLIC, path));
      if (await file.exists()) {
        const ext = path.split(".").pop() ?? "";
        return new Response(file, {
          headers: { "content-type": CONTENT_TYPE[ext] ?? "application/octet-stream" },
        });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        const snapshot: ServerMessage = { type: "snapshot", sessions: manager.list() };
        ws.send(JSON.stringify(snapshot));
      },
      close(ws) {
        clients.delete(ws);
      },
      message(ws, raw) {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        switch (msg.type) {
          case "create":
            // create() is async (it may auto-create a task for the session);
            // fire-and-forget but surface any unexpected failure.
            manager.create(msg).catch((err) =>
              console.error("[server] create failed:", err),
            );
            break;
          case "send":
            manager.send(msg.sessionId, msg.text, msg.images);
            break;
          case "interrupt":
            manager.interrupt(msg.sessionId);
            break;
          case "close":
            manager.close(msg.sessionId);
            break;
          case "delete":
            manager.delete(msg.sessionId);
            break;
        }
      },
    },
  });

  if (!opts.quiet) {
    console.log(`\n  ▸ Agent Console running at http://localhost:${server.port}\n`);
  }
  return server;
}

if (import.meta.main) {
  // Honour `--port 3005`, `--port=3005`, or the PORT env var.
  const argv = process.argv.slice(2);
  let cliPort: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const raw =
      a === "--port" || a === "-p" ? argv[++i] : a.startsWith("--port=") ? a.split("=")[1] : null;
    if (raw != null && Number.isFinite(Number(raw))) cliPort = Number(raw);
  }
  await startServer({ port: cliPort });
}
