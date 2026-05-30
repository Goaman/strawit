// Browser-inspector-style element picker. Activating it dims the cursor to a
// crosshair, highlights whatever element is under the pointer (with a label
// naming the Solid component + tag), and resolves with a rich context object
// when the user clicks — or null if they press Escape.
//
// "Solid component" is recovered from `data-component` attributes that the app
// stamps on the root node of each component (see main.ts / pm.ts). The picker
// walks up from the clicked node collecting that chain, so a click deep inside
// the transcript still reports e.g. `Conversation › TranscriptEntry`.

import { createSignal } from "solid-js";

let nextId = 1;

export interface SelectedElement {
  id: number;
  // Nearest enclosing component (last entry of componentChain), or the tag name
  // when the element sits outside any tagged component.
  component: string;
  // data-component values from outermost to innermost enclosing component.
  componentChain: string[];
  // Compact element descriptor, e.g. "div.entry.assistant".
  tag: string;
  // Full CSS-ish path from the body down to the element.
  domPath: string;
  // Trimmed, collapsed textContent (truncated).
  text: string;
  size: { w: number; h: number };
  // A few interesting attributes (role, type, placeholder, href, …).
  attrs: Record<string, string>;
}

// True while a pick is in progress, so buttons can show an "armed" state.
export const [picking, setPicking] = createSignal(false);

const MAX_TEXT = 160;
const ATTRS_OF_INTEREST = [
  "role",
  "type",
  "placeholder",
  "title",
  "href",
  "aria-label",
  "data-component",
];

function classesOf(el: Element): string[] {
  return (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean);
}

// "div#root.foo.bar" — id wins, else up to a few classes.
function tagDesc(el: Element): string {
  let s = el.tagName.toLowerCase();
  if (el.id) return `${s}#${el.id}`;
  const cls = classesOf(el);
  if (cls.length) s += "." + cls.slice(0, 4).join(".");
  return s;
}

function nthOfType(el: Element): number {
  let i = 1;
  let sib = el.previousElementSibling;
  while (sib) {
    if (sib.tagName === el.tagName) i++;
    sib = sib.previousElementSibling;
  }
  return i;
}

// Build a readable CSS path body→el, stopping early at the first id (unique).
function cssPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  let depth = 0;
  while (cur && cur !== document.body && cur.nodeType === 1 && depth < 8) {
    if (cur.id) {
      parts.unshift(`${cur.tagName.toLowerCase()}#${cur.id}`);
      break;
    }
    let seg = cur.tagName.toLowerCase();
    const cls = classesOf(cur);
    if (cls.length) seg += "." + cls.join(".");
    const n = nthOfType(cur);
    if (n > 1) seg += `:nth-of-type(${n})`;
    parts.unshift(seg);
    cur = cur.parentElement;
    depth++;
  }
  return parts.join(" > ");
}

// data-component values enclosing `el`, outermost first.
function componentChain(el: Element): string[] {
  const chain: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.body) {
    const c = (cur as HTMLElement).dataset?.component;
    if (c) chain.unshift(c);
    cur = cur.parentElement;
  }
  return chain;
}

function describe(el: Element): SelectedElement {
  const chain = componentChain(el);
  const rect = el.getBoundingClientRect();
  const attrs: Record<string, string> = {};
  for (const name of ATTRS_OF_INTEREST) {
    const v = el.getAttribute(name);
    if (v) attrs[name] = v;
  }
  let text = (el.textContent || "").replace(/\s+/g, " ").trim();
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + "…";
  return {
    id: nextId++,
    component: chain.length ? chain[chain.length - 1] : el.tagName.toLowerCase(),
    componentChain: chain,
    tag: tagDesc(el),
    domPath: cssPath(el),
    text,
    size: { w: Math.round(rect.width), h: Math.round(rect.height) },
    attrs,
  };
}

// One element rendered as plain text for the agent message. Indented so it
// reads as a block under a header.
export function serializeElement(el: SelectedElement): string {
  const lines = [
    `component: ${el.componentChain.length ? el.componentChain.join(" › ") : "(outside any component)"}`,
    `dom path: ${el.domPath}`,
    `element: ${el.tag}`,
    `size: ${el.size.w}×${el.size.h}px`,
  ];
  if (el.text) lines.push(`text: "${el.text}"`);
  const extraAttrs = Object.keys(el.attrs).filter((k) => k !== "data-component");
  if (extraAttrs.length) {
    lines.push(`attributes: ${extraAttrs.map((k) => `${k}="${el.attrs[k]}"`).join(", ")}`);
  }
  return lines.map((l) => "  " + l).join("\n");
}

// All referenced elements as a single text block to append to a message.
export function elementsBlock(els: SelectedElement[]): string {
  if (!els.length) return "";
  return els.map((el, i) => `[UI element ${i + 1}]\n${serializeElement(el)}`).join("\n\n");
}

// Start an interactive pick. Resolves with the chosen element's context, or
// null if cancelled. Only one pick runs at a time.
export function pickElement(): Promise<SelectedElement | null> {
  if (picking()) return Promise.resolve(null);

  return new Promise((resolve) => {
    // A non-interactive overlay (pointer-events:none) so elementFromPoint always
    // sees the real app underneath, never our highlight chrome.
    const layer = document.createElement("div");
    layer.className = "el-pick-layer";
    const box = document.createElement("div");
    box.className = "el-pick-box";
    const label = document.createElement("div");
    label.className = "el-pick-label";
    const banner = document.createElement("div");
    banner.className = "el-pick-banner";
    banner.textContent = "🎯 Click any element to attach it  ·  Esc to cancel";
    layer.append(box, label, banner);
    document.body.appendChild(layer);
    document.body.classList.add("el-picking");

    const place = (el: Element) => {
      const r = el.getBoundingClientRect();
      box.style.transform = `translate(${r.left}px, ${r.top}px)`;
      box.style.width = r.width + "px";
      box.style.height = r.height + "px";
      const chain = componentChain(el);
      const name = chain.length ? chain[chain.length - 1] : el.tagName.toLowerCase();
      label.textContent = `${name} · ${tagDesc(el)}`;
      const labelY = r.top > 24 ? r.top - 22 : r.bottom + 4;
      label.style.transform = `translate(${Math.max(0, r.left)}px, ${labelY}px)`;
    };

    const targetAt = (x: number, y: number): Element | null => {
      const el = document.elementFromPoint(x, y);
      if (!el || layer.contains(el)) return null;
      return el;
    };

    let last: Element | null = null;
    const onMove = (e: MouseEvent) => {
      const el = targetAt(e.clientX, e.clientY);
      if (!el || el === last) return;
      last = el;
      place(el);
    };

    const cleanup = () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      layer.remove();
      document.body.classList.remove("el-picking");
      setPicking(false);
    };

    // Swallow the activating click sequence so it never reaches the app
    // (e.g. picking a button must not also press it).
    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onDown = swallow;

    const onClick = (e: MouseEvent) => {
      swallow(e);
      const el = targetAt(e.clientX, e.clientY);
      cleanup();
      resolve(el ? describe(el) : null);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cleanup();
        resolve(null);
      }
    };

    setPicking(true);
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
  });
}
