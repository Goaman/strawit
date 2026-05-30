// Collapse state for UI sections (sub-agent panels, tree nodes, …), persisted
// to localStorage so it survives reloads. A section is identified by a stable
// string id; the set holds the ids that are currently collapsed.

import { createSignal } from "solid-js";

const KEY = "rave-of-agents:collapsed";

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    // ignore malformed / unavailable storage — start fresh
  }
  return new Set();
}

const [collapsed, setCollapsed] = createSignal<Set<string>>(load());

function persist(s: Set<string>) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...s]));
  } catch {
    // storage may be full or disabled; collapse still works for the session
  }
}

// Reactive: re-runs when any section is toggled.
export function isCollapsed(id: string): boolean {
  return collapsed().has(id);
}

export function toggleCollapse(id: string) {
  setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    persist(next);
    return next;
  });
}
