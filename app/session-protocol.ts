// Wire protocol between the (transient) server supervisor and the (long-lived,
// detached) per-session worker processes.
//
// Each worker owns ONE session's live `query()` and listens on a unix-domain
// socket. The server connects as a client. Because the worker is a separate,
// detached process, it (and the `claude` subprocess it drives) keeps running
// when the server stops; a restarted server simply reconnects to the socket and
// resumes streaming — the agent never died.
//
// Framing is newline-delimited JSON. Messages never contain a raw newline
// because they are JSON.stringify'd (newlines inside strings are escaped).

import type { Socket } from "node:net";
import type {
  ImageAttachment,
  SessionMeta,
  SessionSnapshot,
  SubAgentNode,
  TranscriptEntry,
} from "./types.ts";

// Server → worker.
export type WorkerCommand =
  | { cmd: "send"; text: string; images?: ImageAttachment[] }
  | { cmd: "interrupt" }
  | { cmd: "close" } // end the agent (close the input stream) but keep files
  | { cmd: "delete" }; // stop and erase all on-disk traces, then exit

// Worker → server. The first message on every new connection is a `snapshot`
// carrying the full current state, so a freshly-(re)connected server is in sync
// without replaying history. Subsequent messages are incremental.
export type WorkerEvent =
  | { type: "snapshot"; session: SessionSnapshot }
  | { type: "session_updated"; session: SessionMeta }
  | { type: "entry"; sessionId: string; entry: TranscriptEntry }
  | { type: "tree"; sessionId: string; subAgents: SubAgentNode[] }
  | { type: "gone"; id: string }; // worker is exiting after close/delete

// Decode a stream of newline-delimited JSON messages off a socket, invoking
// `onMessage` for each complete line. Returns nothing; attach your own
// close/error handlers on the socket.
export function readLines<T>(sock: Socket, onMessage: (msg: T) => void): void {
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line) as T);
      } catch {
        /* skip malformed line */
      }
    }
  });
}

// Write one message as a single newline-terminated JSON line. Swallows errors
// from a half-closed socket (the peer may have gone away mid-write).
export function writeLine(sock: Socket, msg: unknown): void {
  try {
    sock.write(JSON.stringify(msg) + "\n");
  } catch {
    /* peer gone */
  }
}
