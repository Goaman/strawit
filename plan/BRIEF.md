# Project Brief — "Rave of Agents" (working title)

## What exists today
This repo contains a **super-agent** system: a tiny stdio MCP server
(`.claude/skills/super-agent/server.mjs`) that exposes one tool, `super_agent`.
Calling it spawns a fresh headless `claude -p` process that *also* has the
`super_agent` tool, so agents can recursively spawn sub-agents to arbitrary depth
(unlike Claude Code's built-in Task tool, which only nests one level).

Key facts the visualizer depends on:
- Every spawn/return is appended as **JSON Lines** to `~/.claude/super-agent.log`
  (override with env `SUPER_AGENT_LOG`).
- Each log line has fields: `ts` (ISO time), `pid`, `depth` (0 = top), `event`,
  and event-specific fields.
- Events: `server_start`, `spawn` (adds `childDepth`, `model`, `prompt`),
  `child_done` (adds `childDepth`, `resultPreview`), `depth_limit`,
  `spawn_error`, `child_exit`, `parse_error`.
- A parent process (a given `pid`/`depth`) emits `spawn` then later `child_done`;
  the child runs as a new process at `depth+1` and emits its own `server_start`.
- Depth guard: `SUPER_AGENT_MAX_DEPTH` (default 5).

## What we are building
A **Bun**-powered server + frontend that renders the live super-agent activity as a
real-time **"game / simulation" with a RAVE vibe**. We want to *feel* the agent tree:
agents as entities on a neon dancefloor, spawning a child = birth/drop, a child
finishing = it returns to its parent, transcripts streaming as glowing text, all
beat-synced and audio-reactive. Parent→child lineage must be visually obvious.

Hard requirements:
- **Bun** for the server (HTTP + WebSocket; `Bun.serve`). Frontend served by Bun.
- **Real-time**: tail `~/.claude/super-agent.log`, push events over WebSocket.
- Show the **agent tree / lineage** (who spawned whom) and **live transcripts**.
- **Rave aesthetic**: neon, dark, beat/laser/particle energy, audio-reactive.
- Must actually run with `bun run` and degrade gracefully if the log is empty
  (include a demo/replay mode that synthesizes fake agent activity so the visuals
  are alive even with no real agents running).

## Context: the hackathon
Built for a hackathon at **Winter Circus (Wintercircus), Ghent, Belgium**
(https://www.wintercircus.be/nl/events/id/612) — a beautifully restored historic
circus building now used as a tech/innovation/events venue. The "circus" + "rave"
themes can blend: spectacle, performers (agents) under the big-top, lights, energy.
Aim for something demo-able and jaw-dropping on a big screen / projector.

## Constraints for planners & implementers
- Keep it runnable on macOS with Bun already installed. No exotic native deps.
- Prefer dependency-light: vanilla JS/Canvas/WebGL/WebAudio in the browser is great;
  small libs OK if justified. The server should ideally be pure Bun stdlib.
- All app code lives under `app/` in this repo.
