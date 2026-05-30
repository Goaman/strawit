// A reusable conversation textbox — richer than a bare <textarea>. It holds
// "widget" chips (referenced UI elements + attached images) inside the input
// box, and a "/" command menu (like /attach, /select) that appears as you type
// a slash token. Used by both the new-agent form and the live composer, so an
// element you pick with the inspector shows up as a removable widget and its
// full context is folded into the message text on send.

import html from "solid-js/html";
import { createSignal } from "solid-js";
import { createImagePicker, type PickedImage } from "./images.ts";
import { elementsBlock, pickElement, picking, type SelectedElement } from "./selector.ts";
import type { ImageAttachment } from "../types.ts";

export interface ComposerOptions {
  // Placeholder text — a string or an accessor for reactive placeholders.
  placeholder?: string | (() => string);
  rows?: number;
  // Cmd/Ctrl+Enter handler (live composer "send"; form "launch"). Omit to disable.
  onSubmit?: () => void;
  // When set, renders a primary action button with this (reactive) label.
  submitLabel?: () => string;
}

export interface Composer {
  node: any; // the rendered solid-js/html element
  // Message body with referenced-element context appended (trimmed body + block).
  composeMessage: () => string;
  images: () => PickedImage[];
  payloadImages: () => ImageAttachment[];
  elements: () => SelectedElement[];
  hasContent: () => boolean;
  clear: () => void;
  focus: () => void;
}

interface SlashCommand {
  name: string;
  hint: string;
  run: () => void;
}

export function createComposer(opts: ComposerOptions = {}): Composer {
  const picker = createImagePicker();
  const [elements, setElements] = createSignal<SelectedElement[]>([]);
  const [text, setText] = createSignal("");
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [activeIdx, setActiveIdx] = createSignal(0);
  // The "+" button opens the same command list as a click-driven popover
  // (vs. the "/"-typed slash menu above).
  const [plusOpen, setPlusOpen] = createSignal(false);

  let textarea!: HTMLTextAreaElement;
  let fileEl!: HTMLInputElement;

  const startPick = async () => {
    const el = await pickElement();
    if (el) setElements((l) => [...l, el]);
    textarea?.focus();
  };
  const removeElement = (id: number) => setElements((l) => l.filter((e) => e.id !== id));

  const COMMANDS: SlashCommand[] = [
    { name: "attach", hint: "Attach image file(s)", run: () => fileEl.click() },
    { name: "select", hint: "Pick a UI element from this page", run: () => void startPick() },
  ];
  const filtered = (): SlashCommand[] => {
    const q = query().toLowerCase();
    if (!q) return COMMANDS;
    return COMMANDS.filter((c) => c.name.startsWith(q) || c.hint.toLowerCase().includes(q));
  };

  // A "/word" token at the caret (line start or after whitespace) opens the menu.
  const slashMatch = (): RegExpMatchArray | null => {
    const v = textarea.value;
    const caret = textarea.selectionStart ?? v.length;
    return v.slice(0, caret).match(/(^|\s)\/([\w-]*)$/);
  };
  const detectSlash = () => {
    const m = slashMatch();
    if (m) {
      setQuery(m[2]);
      setActiveIdx(0);
      setMenuOpen(true);
    } else {
      setMenuOpen(false);
    }
  };

  const runCommand = (cmd: SlashCommand) => {
    // Strip the "/query" token before running the command.
    const v = textarea.value;
    const caret = textarea.selectionStart ?? v.length;
    const m = slashMatch();
    if (m) {
      const slashPos = caret - m[2].length - 1;
      const next = v.slice(0, slashPos) + v.slice(caret);
      textarea.value = next;
      setText(next);
      textarea.setSelectionRange(slashPos, slashPos);
    }
    setMenuOpen(false);
    cmd.run();
  };

  // Run a command picked from the "+" popover (no slash token to strip).
  const runPlainCommand = (cmd: SlashCommand) => {
    setPlusOpen(false);
    cmd.run();
  };

  // Grow the textarea with its content (CSS caps it via max-height).
  const autosize = () => {
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  };

  const onInput = () => {
    setText(textarea.value);
    setPlusOpen(false);
    autosize();
    detectSlash();
  };

  const onKey = (e: KeyboardEvent) => {
    const opts2 = filtered();
    if (menuOpen() && opts2.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % opts2.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + opts2.length) % opts2.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault();
        runCommand(opts2[activeIdx()]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuOpen(false);
        return;
      }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && opts.onSubmit) {
      e.preventDefault();
      opts.onSubmit();
    }
  };

  const clear = () => {
    if (textarea) {
      textarea.value = "";
      textarea.style.height = "auto";
    }
    setText("");
    picker.clear();
    setElements([]);
    setMenuOpen(false);
    setPlusOpen(false);
  };
  const focus = () => textarea?.focus();

  const composeMessage = (): string => {
    const body = (textarea?.value ?? text()).trim();
    const ctx = elementsBlock(elements());
    if (!ctx) return body;
    const header = "--- referenced UI element(s) ---";
    return body ? `${body}\n\n${header}\n${ctx}` : `${header}\n${ctx}`;
  };

  const hasContent = () =>
    text().trim().length > 0 || picker.images().length > 0 || elements().length > 0;

  const placeholder = () =>
    (typeof opts.placeholder === "function" ? opts.placeholder() : opts.placeholder) ??
    "Type a message…  ( / for commands )";

  const ElementChip = (el: SelectedElement) => {
    const title = [
      `component: ${el.componentChain.join(" › ") || "(outside any component)"}`,
      `dom: ${el.domPath}`,
      `element: ${el.tag}`,
      `size: ${el.size.w}×${el.size.h}px`,
      el.text ? `text: ${el.text}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return html`<span class="chip elem" title=${title} data-component="ElementChip">
      <span class="chip-ico">🎯</span>
      <span class="chip-label">${el.component}</span>
      <span class="chip-sub">${el.tag}</span>
      <button type="button" class="chip-x" title="Remove" onClick=${() => removeElement(el.id)}>✕</button>
    </span>`;
  };

  const node = html`
    <div class="composer2" data-component="Composer"
      onDragOver=${(e: DragEvent) => e.preventDefault()}
      onDrop=${(e: DragEvent) => {
        e.preventDefault();
        if (e.dataTransfer?.files?.length) void picker.addFiles(e.dataTransfer.files);
      }}>
      <input type="file" accept="image/*" multiple class="attach-input"
        ref=${(el: HTMLInputElement) => (fileEl = el)}
        onChange=${(e: Event) => {
          const input = e.currentTarget as HTMLInputElement;
          if (input.files) void picker.addFiles(input.files);
          input.value = "";
        }} />

      <div class="composer2-box">
        ${() =>
          elements().length || picker.images().length
            ? html`<div class="chips">
                ${() => elements().map((el: SelectedElement) => ElementChip(el))}
                ${() =>
                  picker.images().map(
                    (img: PickedImage) => html`
                      <div class="thumb" title=${img.name}>
                        <img src=${img.url} alt=${img.name} />
                        <button type="button" class="thumb-x" title="Remove"
                          onClick=${() => picker.remove(img.id)}>✕</button>
                      </div>`,
                  )}
              </div>`
            : ""}

        <textarea class="composer2-input" rows=${opts.rows ?? 2}
          ref=${(el: HTMLTextAreaElement) => (textarea = el)}
          placeholder=${placeholder}
          onInput=${onInput}
          onKeyDown=${onKey}
          onPaste=${(e: ClipboardEvent) => picker.addFromClipboard(e.clipboardData)}
          onBlur=${() => setTimeout(() => setMenuOpen(false), 120)}></textarea>

        ${() =>
          menuOpen() && filtered().length
            ? html`<div class="slash-menu">
                ${() =>
                  filtered().map(
                    (c: SlashCommand, i: number) => html`
                      <div class="slash-item" classList=${() => ({ active: i === activeIdx() })}
                        onMouseEnter=${() => setActiveIdx(i)}
                        onMouseDown=${(e: MouseEvent) => {
                          e.preventDefault();
                          runCommand(c);
                        }}>
                        <span class="slash-name">/${c.name}</span>
                        <span class="slash-hint">${c.hint}</span>
                      </div>`,
                  )}
              </div>`
            : ""}

        <div class="composer2-bar">
          <div class="composer2-left">
            <button type="button" class="round-btn plus-btn" classList=${() => ({ active: plusOpen() })}
              title="Add — attach an image or point at the UI"
              onMouseDown=${(e: MouseEvent) => {
                e.preventDefault();
                setPlusOpen((v) => !v);
              }}>
              <span class="plus-glyph">+</span>
            </button>
            ${() =>
              plusOpen()
                ? html`<div class="plus-menu">
                    ${COMMANDS.map(
                      (c: SlashCommand) => html`
                        <div class="slash-item"
                          onMouseDown=${(e: MouseEvent) => {
                            e.preventDefault();
                            runPlainCommand(c);
                          }}>
                          <span class="slash-ico">${c.name === "attach" ? "📎" : "🎯"}</span>
                          <span class="slash-name">/${c.name}</span>
                          <span class="slash-hint">${c.hint}</span>
                        </div>`,
                    )}
                  </div>`
                : ""}
          </div>

          <div class="composer2-right">
            <button type="button" class="round-btn" title="Attach image(s)  ( /attach )"
              onMouseDown=${(e: MouseEvent) => e.preventDefault()}
              onClick=${() => fileEl.click()}>📎</button>
            <button type="button" class="round-btn" classList=${() => ({ active: picking() })}
              title="Select a UI element  ( /select )"
              onMouseDown=${(e: MouseEvent) => e.preventDefault()}
              onClick=${() => void startPick()}>🎯</button>
            ${opts.submitLabel
              ? html`<button class="round-btn send-btn" type="button"
                  title=${() => opts.submitLabel!()}
                  onClick=${() => opts.onSubmit?.()}>
                  <span class="send-glyph">↑</span>
                </button>`
              : ""}
          </div>
        </div>
      </div>
    </div>
  `;

  return {
    node,
    composeMessage,
    images: picker.images,
    payloadImages: picker.payload,
    elements,
    hasContent,
    clear,
    focus,
  };
}
