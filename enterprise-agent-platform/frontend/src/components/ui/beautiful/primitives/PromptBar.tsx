/* Adapted from Beautiful UI components/primitives/PromptBar.tsx (MIT, see ../NOTICE).
 * Adaptations:
 * - the self-running demo, demo @ sources, demo files and dictation are removed; every control is real:
 *   attach (+, paste, drag and drop) reports files to the caller, which owns uploads and chip state; paste reads
 *   the clipboard's file items (some browsers and apps leave `files` empty) and names unnamed images
 *   (`clipboardFiles`, also used by callers that accept pastes outside the textarea);
 *   `/` commands, the model list and send/stop come from props;
 * - a stop control takes the dictation slot while the agent is working (send remains available for steering);
 * - the textarea is controlled by the caller so drafts survive re-renders and can be pre-filled;
 * - IME composition never sends; menus get listbox/menu roles; the glimm sweep marks a model change and is
 *   skipped under reduced motion or without WebGL; labels come from the caller (i18n);
 * - the send button uses the accent token (brand colour) per docs/design/frontend.md;
 * - accessibility: controls grow to 44px through the app's `touch:` variant (coarse pointers and narrow screens)
 *   rather than `pointer-coarse:` alone, the grid columns size to those targets, and the placeholder uses ink-2 for
 *   4.5:1 contrast.
 * Markup, classes, radii and motion are upstream's. */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createShader, playSweep, accentChain, ACCENTS, type ShaderController } from "glimm";

const PASTE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp" };

/** Files on a paste's clipboard: file items first (some browsers and apps leave `files` empty), else `files`.
 * Clipboard images often have no name; they get `pasted-image-N.<ext>`. */
export function clipboardFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  let files = Array.from(data.items ?? []).flatMap((item) => {
    const file = item.kind === "file" ? item.getAsFile() : null;
    return file ? [file] : [];
  });
  if (!files.length) files = Array.from(data.files ?? []);
  let unnamed = 0;
  return files.map((file) => {
    if (file.name) return file;
    const type = file.type || "image/png";
    return new File([file], `pasted-image-${++unnamed}.${PASTE_EXTENSIONS[type] ?? "png"}`, { type, lastModified: file.lastModified || Date.now() });
  });
}

/* The built-in "prism" palette is only cyan→indigo→magenta, so a sweep
 * reads as blue/purple. Build a true full-spectrum rainbow instead. */
const RAINBOW = accentChain([
  ACCENTS.red,
  ACCENTS.orange,
  ACCENTS.yellow,
  ACCENTS.green,
  ACCENTS.cyan,
  ACCENTS.blue,
  ACCENTS.purple,
]);

/* ─────────────────────────────────────────────────────────
 * PROMPT BAR
 * A composer with real controls: attach, / commands, a
 * model picker, stop, and send.
 * Type / to open the command menu; ↑↓ + Enter to pick.
 * Variants: Rounded (card radius) · Pill (full radius).
 * ───────────────────────────────────────────────────────── */

function Icon({ children, size = 15, strokeWidth = 1.8 }: { children: ReactNode; size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export type PromptCommand = { key: string; name: string; desc: string };
export type PromptModel = { key: string; name: string; tag?: string };
export type PromptAttachment = {
  key: string | number;
  name: string;
  state: "uploading" | "ready" | "error";
  /** error text, or size once uploaded */
  detail?: string;
};

export type PromptBarLabels = {
  prompt: string;
  attach: string;
  remove: (name: string) => string;
  chooseModel: string;
  send: string;
  stop: string;
  commandsHint: string;
  noMatches: (query: string) => string;
  dropFiles: string;
};

/* the last /word being typed at the start of the draft or after whitespace */
function parseSlash(draft: string): { query: string; start: number } | null {
  const match = /(^|\s)\/([\w-]*)$/.exec(draft);
  if (!match) return null;
  return { query: match[2].toLowerCase(), start: match.index + match[1].length };
}

export default function PromptBar({
  variant = "Rounded",
  tall = false,
  placeholder,
  draft,
  onDraftChange,
  attachments = [],
  onAttach,
  onRemoveAttachment,
  commands = [],
  onCommand,
  models,
  model,
  onModelChange,
  modelDisabled = false,
  canSend,
  onSend,
  working = false,
  onStop,
  stopping = false,
  status,
  labels,
  inputRef: externalInputRef,
}: {
  variant?: "Rounded" | "Pill";
  /** hero sizing: a multi-line input with controls on their own row */
  tall?: boolean;
  placeholder?: string;
  draft: string;
  onDraftChange: (draft: string) => void;
  attachments?: PromptAttachment[];
  onAttach?: (files: File[]) => void;
  onRemoveAttachment?: (key: PromptAttachment["key"]) => void;
  commands?: PromptCommand[];
  /** a `/command` was picked; the typed token is removed from the draft first */
  onCommand?: (key: string) => void;
  models?: PromptModel[];
  /** the selected model key; may be outside `models` when policy no longer allows it */
  model?: string;
  onModelChange?: (key: string) => void;
  modelDisabled?: boolean;
  canSend: boolean;
  onSend: () => void;
  /** the agent is working: show stop next to send */
  working?: boolean;
  onStop?: () => void;
  stopping?: boolean;
  /** one quiet line above the controls (queue position, errors) */
  status?: ReactNode;
  labels: PromptBarLabels;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const pill = variant === "Pill";
  const ids = useId();
  const [dismissed, setDismissed] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const wide = expanded || tall;
  const [rowBox, setRowBox] = useState<{ top: number; height: number } | null>(null);
  const [engaged, setEngaged] = useState(false);
  const [modelBox, setModelBox] = useState<{ top: number; height: number } | null>(null);
  const [modelHovered, setModelHovered] = useState<number | null>(null);
  const [modelMenuLeft, setModelMenuLeft] = useState(0);
  const [modelMenuBottom, setModelMenuBottom] = useState(0);
  const composerAnchorRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const ownInputRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = externalInputRef ?? ownInputRef;
  const fileRef = useRef<HTMLInputElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const modelRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const modelRowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const glimmRef = useRef<HTMLCanvasElement>(null);
  const shaderRef = useRef<ShaderController | null>(null);
  const sweepingRef = useRef(false);
  const composingRef = useRef(false);

  const token = dismissed || commands.length === 0 ? null : parseSlash(draft);
  const query = token?.query ?? "";
  const rows = token ? commands.filter((c) => c.name.slice(1).toLowerCase().startsWith(query)) : [];
  const menuOpen = token !== null;
  const hasModels = models !== undefined;
  const selectedModel = models?.find((m) => m.key === model);

  useEffect(() => {
    setActive(0);
    setEngaged(false);
  }, [menuOpen, query]);

  /* a single highlight glides to the active row instead of each row
   * toggling its own background — matches the gliding pill in the nav */
  useLayoutEffect(() => {
    const target = rowRefs.current[active];
    if (target) setRowBox({ top: target.offsetTop, height: target.offsetHeight });
  }, [menuOpen, query, active, rows.length]);

  /* same gliding highlight in the model menu — floats to the hovered
   * row, falling back to the currently-selected model */
  const modelIndex = models?.findIndex((m) => m.key === model) ?? -1;
  useLayoutEffect(() => {
    if (!modelOpen) return;
    const target = modelRowRefs.current[modelHovered ?? modelIndex];
    if (target) setModelBox({ top: target.offsetTop, height: target.offsetHeight });
  }, [modelOpen, modelHovered, modelIndex]);

  /* The menu is outside the clipped composer, so align it to the model
   * trigger by measurement instead of pinning it to the far-right edge. */
  useLayoutEffect(() => {
    if (!modelOpen || !composerAnchorRef.current || !modelRef.current) return;
    const anchorRect = composerAnchorRef.current.getBoundingClientRect();
    const triggerRect = modelRef.current.getBoundingClientRect();
    setModelMenuLeft(Math.max(0, Math.min(triggerRect.left - anchorRect.left, anchorRect.width - 224)));
    setModelMenuBottom(anchorRect.bottom - triggerRect.top + 8);
  }, [modelOpen, wide, model]);

  useEffect(() => {
    if (!modelOpen) setModelHovered(null);
  }, [modelOpen]);

  /* Build the shader with a pinned hue phase. createShader seeds its
   * internal hueShift from Math.random(), which made the sweep a different
   * colour on every reload — pin it so the rainbow is identical each time.
   * Without WebGL there is simply no sweep. */
  const makeShader = () => {
    const canvas = glimmRef.current;
    if (!canvas) return null;
    const random = Math.random;
    Math.random = () => 0;
    try {
      return createShader({
        canvas,
        palette: RAINBOW,
        direction: "ltr",
        bandTight: 10,
        swellAmount: 0.85,
      });
    } catch {
      return null;
    } finally {
      Math.random = random;
    }
  };

  useEffect(() => () => {
    shaderRef.current?.destroy();
    shaderRef.current = null;
  }, []);

  const celebrate = () => {
    if (sweepingRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Recreate the shader per sweep so uTime restarts at 0 — the hue phase
    // (which drifts with time) is then identical on every trigger.
    shaderRef.current?.destroy();
    const shader = makeShader();
    shaderRef.current = shader;
    if (!shader) return;
    sweepingRef.current = true;
    const sweep = playSweep(shader, {
      palette: RAINBOW,
      direction: "ltr",
      sweepMs: 570,
      outroMs: 80,
      peakAlpha: 1.3,
      bandTight: 10,
      brightness: 1.4,
      swellAmount: 1,
      waveSpeed: 1.8,
      easing: "easeOutExpo",
    });
    void sweep.done.finally(() => {
      sweepingRef.current = false;
    });
  };

  const selectModel = (next: PromptModel) => {
    setModelOpen(false);
    if (next.key === model) return;
    onModelChange?.(next.key);
    celebrate();
  };

  /* Move wrapped text above the controls, then grow to a compact maximum. */
  useLayoutEffect(() => {
    const input = inputRef.current;
    const controls = controlsRef.current;
    const measure = measureRef.current;
    if (!input || !controls || !measure) return;

    const fixedControlsWidth = 28 * (working ? 3 : 2) + (modelRef.current?.offsetWidth ?? 0);
    const inlineGaps = 4 * 4;
    const inlineInputWidth = controls.clientWidth - fixedControlsWidth - inlineGaps;
    const needsFullWidth = draft.includes("\n") || measure.offsetWidth + 8 > inlineInputWidth;
    if (needsFullWidth !== expanded) {
      setExpanded(needsFullWidth);
    }

    const minHeight = tall ? 68 : 28;
    const maxHeight = tall ? 200 : 100;
    input.style.height = "0px";
    const contentHeight = input.scrollHeight;
    input.style.height = `${Math.min(Math.max(contentHeight, minHeight), maxHeight)}px`;
    input.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
  }, [draft, expanded, tall, working, inputRef]);

  /* clicking anywhere outside the composer closes the open menus */
  useEffect(() => {
    if (!modelOpen) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as Element).closest("[data-promptbar]")) setModelOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [modelOpen]);

  const pick = (row: PromptCommand) => {
    onDraftChange(token ? draft.slice(0, token.start).trimEnd() : draft);
    setDismissed(false);
    onCommand?.(row.key);
    inputRef.current?.focus();
  };

  const send = () => {
    if (!canSend) return;
    onSend();
    setModelOpen(false);
  };

  const attachFiles = (files: File[]) => {
    if (files.length && onAttach) onAttach(files);
  };

  const round = pill ? "rounded-full" : "rounded-[8px]";
  const listboxId = `${ids}-commands`;

  return (
    <div data-promptbar className="w-full">
      {/* composer is the anchor — menus grow up from its top edge */}
      <div ref={composerAnchorRef} className="relative">
      {/* ── slash menu ─────────────────────────────────── */}
      {menuOpen && (
        <div
          onMouseLeave={() => setEngaged(false)}
          className="absolute inset-x-0 bottom-full z-10 mb-2 rounded-[10px] bg-surface p-1 shadow-raised"
          style={{ animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "bottom center" }}
        >
          {/* single gliding highlight — appears once a row is hovered */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-1 rounded-[6px] bg-hover"
            style={{
              top: rowBox?.top ?? 0,
              height: rowBox?.height ?? 0,
              opacity: rowBox && engaged && rows.length > 0 ? 1 : 0,
              transition:
                "top 220ms cubic-bezier(0.23,1,0.32,1), height 220ms cubic-bezier(0.23,1,0.32,1), opacity 150ms ease",
            }}
          />
          <div id={listboxId} role="listbox" aria-label={labels.commandsHint}>
          {rows.map((row, i) => (
            <button
              key={row.key}
              id={`${listboxId}-${i}`}
              type="button"
              role="option"
              aria-selected={i === active}
              tabIndex={-1}
              ref={(el) => {
                rowRefs.current[i] = el;
              }}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => {
                setActive(i);
                setEngaged(true);
              }}
              onClick={() => pick(row)}
              className="relative z-10 flex h-9 w-full items-center gap-2.5 rounded-[6px] px-2 text-left pointer-coarse:h-11"
            >
              <span className="shrink-0 font-mono text-[12.5px] font-medium text-ink">
                {row.name}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink-2">{row.desc}</span>
            </button>
          ))}
          </div>
          {rows.length === 0 && (
            <div className="flex h-9 items-center px-2 text-[12px] text-ink-2">
              {labels.noMatches(query)}
            </div>
          )}
          <div className="mt-1 border-t border-line px-2 pt-1.5 pb-1 text-[11px] text-ink-2">
            {labels.commandsHint}
          </div>
        </div>
      )}

      {/* ── model menu ─────────────────────────────────── */}
      {modelOpen && models && (
        <div
          role="menu"
          aria-label={labels.chooseModel}
          onMouseLeave={() => setModelHovered(null)}
          className="absolute z-10 w-56 rounded-[10px] bg-surface p-1 shadow-raised"
          style={{ left: modelMenuLeft, bottom: modelMenuBottom, animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "bottom left" }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setModelOpen(false);
              modelRef.current?.focus();
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const current = modelRowRefs.current.findIndex((row) => row === document.activeElement);
              const next = (current + (event.key === "ArrowDown" ? 1 : models.length - 1)) % models.length;
              modelRowRefs.current[next]?.focus();
              setModelHovered(next);
            }
          }}
        >
          {/* single gliding highlight — floats to the hovered / selected row */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-1 rounded-[6px] bg-hover"
            style={{
              top: modelBox?.top ?? 0,
              height: modelBox?.height ?? 0,
              opacity: modelBox && modelHovered !== null ? 1 : 0,
              transition:
                "top 220ms cubic-bezier(0.23,1,0.32,1), height 220ms cubic-bezier(0.23,1,0.32,1), opacity 150ms ease",
            }}
          />
          {models.map((m, i) => (
            <button
              key={m.key}
              type="button"
              role="menuitemradio"
              aria-checked={m.key === model}
              ref={(el) => {
                modelRowRefs.current[i] = el;
              }}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setModelHovered(i)}
              onFocus={() => setModelHovered(i)}
              onClick={() => {
                selectModel(m);
                inputRef.current?.focus();
              }}
              className="relative z-10 flex h-7.5 w-full items-center gap-2 rounded-[6px] px-2 text-left outline-offset-[-2px] pointer-coarse:h-11 max-sm:h-11"
            >
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{m.name}</span>
              {m.tag && <span className="shrink-0 text-[11px] text-ink-2">{m.tag}</span>}
              <span className={`shrink-0 text-ink ${m.key === model ? "" : "invisible"}`}>
                <Icon size={13} strokeWidth={2.5}><path d="M20 6L9 17l-5-5" /></Icon>
              </span>
            </button>
          ))}
        </div>
      )}

      {/* ── composer ───────────────────────────────────── */}
      <div
        className={`relative isolate flex flex-col overflow-hidden border bg-surface shadow-card transition-[border-color,border-radius] duration-150 focus-within:border-line-strong ${
          dragging ? "border-accent" : "border-line"
        } ${
          tall ? "gap-2.5 p-3.5" : "gap-1.5 p-1.5"
        } ${
          pill ? (attachments.length > 0 || wide ? "rounded-[24px]" : "rounded-full") : tall ? "rounded-[22px]" : "rounded-[14px]"
        }`}
        onDragOver={(event) => {
          if (!onAttach || !Array.from(event.dataTransfer.types).includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          if (!onAttach) return;
          event.preventDefault();
          setDragging(false);
          attachFiles(Array.from(event.dataTransfer.files));
        }}
      >
        {/* rainbow glimm sweep — plays across the interior on model change.
            explicit w/h: a <canvas> is a replaced element and won't stretch
            to inset-0 alone, which feeds back into the shader's ResizeObserver. */}
        <canvas
          ref={glimmRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 h-full w-full"
          style={{ borderRadius: "inherit" }}
        />
        <span
          ref={measureRef}
          aria-hidden="true"
          className="pointer-events-none absolute invisible whitespace-pre text-[13px] leading-[18px]"
        >
          {draft}
        </span>
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-accent-tint/80 text-[12.5px] font-medium text-accent-ink" style={{ borderRadius: "inherit" }}>
            {labels.dropFiles}
          </div>
        )}

        {attachments.length > 0 && (
          <div className={`flex flex-wrap gap-1.5 pt-0.5 ${pill ? "px-1" : "px-0.5"}`}>
            {attachments.map((file) => (
              <span
                key={file.key}
                title={file.detail}
                className={`flex h-6.5 max-w-full items-center gap-1.5 bg-field py-1 pr-1 pl-1.5 text-[11.5px] shadow-hairline ${
                  file.state === "error" ? "text-red" : "text-ink-2"
                } ${pill ? "rounded-full" : "rounded-chip"}`}
                style={{ animation: "pop-in 200ms cubic-bezier(0.23,1,0.32,1) both" }}
              >
                {file.state === "uploading" ? (
                  <span aria-hidden className="size-3 shrink-0 rounded-full border-[1.5px] border-line-strong border-t-ink-2" style={{ animation: "spin 700ms linear infinite" }} />
                ) : file.state === "error" ? (
                  <Icon size={12}><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></Icon>
                ) : (
                  <Icon size={12}><g><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></g></Icon>
                )}
                <span className="max-w-36 truncate">{file.name}</span>
                {file.detail && <span className={`max-w-48 truncate ${file.state === "error" ? "" : "text-ink-2"}`}>{file.detail}</span>}
                <button
                  type="button"
                  aria-label={labels.remove(file.name)}
                  onClick={() => onRemoveAttachment?.(file.key)}
                  className={`-my-1 flex size-6 shrink-0 items-center justify-center text-ink-3 transition-colors duration-100 hover:bg-line/70 hover:text-ink touch:size-11 ${
                    pill ? "rounded-full" : "rounded-[5px]"
                  }`}
                >
                  <Icon size={10} strokeWidth={2.5}><path d="M18 6L6 18M6 6l12 12" /></Icon>
                </button>
              </span>
            ))}
          </div>
        )}

        {status && <div className="px-1 text-[12px] text-ink-2" role="status">{status}</div>}

        <div
          ref={controlsRef}
          className={`grid items-end gap-x-1 gap-y-1.5 ${
            wide
              ? "grid-cols-[auto_auto_minmax(0,1fr)_auto_auto]"
              : "grid-cols-[auto_minmax(0,1fr)_auto_auto_auto]"
          }`}
        >
          {onAttach && (
            <>
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                data-testid="composer-file"
                onChange={(event) => {
                  attachFiles(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                aria-label={labels.attach}
                title={labels.attach}
                onClick={() => {
                  setModelOpen(false);
                  fileRef.current?.click();
                }}
                className={`flex size-7 shrink-0 items-center justify-center justify-self-start text-ink-3 transition-[background-color,color,transform] duration-150 hover:bg-hover hover:text-ink active:scale-[0.94] touch:size-11 ${round} ${wide ? "col-start-1 row-start-2" : "col-start-1 row-start-1"}`}
              >
                <Icon size={16} strokeWidth={2}><path d="M12 5v14M5 12h14" /></Icon>
              </button>
            </>
          )}

          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            role={commands.length ? "combobox" : undefined}
            aria-expanded={commands.length ? menuOpen : undefined}
            aria-controls={menuOpen ? listboxId : undefined}
            aria-autocomplete={commands.length ? "list" : undefined}
            aria-activedescendant={menuOpen && rows.length ? `${listboxId}-${active}` : undefined}
            onChange={(event) => {
              onDraftChange(event.target.value);
              setDismissed(false);
            }}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            onPaste={(event) => {
              const files = clipboardFiles(event.clipboardData);
              if (files.length && onAttach) {
                event.preventDefault();
                attachFiles(files);
              }
            }}
            onKeyDown={(event) => {
              const composing = event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229;
              if (composing) return;
              if (menuOpen && rows.length > 0) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setEngaged(true);
                  setActive((current) => (current + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
                  return;
                }
                if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
                  event.preventDefault();
                  pick(rows[active]);
                  return;
                }
              }
              if (event.key === "Escape") {
                setDismissed(true);
                setModelOpen(false);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            placeholder={placeholder}
            aria-label={labels.prompt}
            className={`${tall ? "min-h-[68px] px-2 py-2 text-[14px] leading-5" : "min-h-7 px-1 py-[5px] text-[13px] leading-[18px]"} min-w-0 w-full resize-none bg-transparent text-ink outline-none [overflow-wrap:anywhere] placeholder:text-ink-2 ${
              wide ? "col-span-full col-start-1 row-start-1" : "col-start-2 row-start-1"
            }`}
          />

          {/* model picker */}
          {hasModels && (
            <button
              ref={modelRef}
              type="button"
              aria-haspopup="menu"
              aria-expanded={modelOpen}
              aria-label={`${labels.chooseModel}: ${selectedModel?.name ?? model ?? ""}`}
              disabled={modelDisabled}
              onClick={() => setModelOpen((current) => !current)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setModelOpen(true);
                  requestAnimationFrame(() => modelRowRefs.current[Math.max(0, modelIndex)]?.focus());
                }
              }}
              className={`flex h-7 min-w-0 shrink items-center gap-1 px-1.5 text-[12px] font-medium transition-colors duration-150 enabled:hover:bg-hover enabled:hover:text-ink disabled:opacity-50 touch:h-11 ${
                selectedModel ? "text-ink-2" : "text-orange"
              } ${round} ${wide ? "col-start-2 row-start-2 justify-self-start" : "col-start-3 row-start-1"}`}
            >
              <span className="truncate">{selectedModel?.name ?? model}</span>
              <span className="text-ink-3">
                <Icon size={11} strokeWidth={2.4}><path d="M6 9l6 6 6-6" /></Icon>
              </span>
            </button>
          )}

          {/* stop — takes upstream's dictation slot while the agent works */}
          {working && onStop && (
            <button
              type="button"
              aria-label={labels.stop}
              title={labels.stop}
              disabled={stopping}
              onClick={onStop}
              className={`flex size-7 shrink-0 items-center justify-center text-ink-2 shadow-btn transition-[background-color,color,transform] duration-150 enabled:hover:bg-hover enabled:hover:text-ink enabled:active:scale-[0.94] disabled:opacity-50 touch:size-11 ${round} ${wide ? "col-start-4 row-start-2" : "col-start-4 row-start-1"}`}
            >
              <span className="size-2.5 rounded-[2px] bg-current" />
            </button>
          )}

          {/* send — tactile square (round in the pill variant) */}
          <button
            type="button"
            aria-label={labels.send}
            disabled={!canSend}
            onClick={send}
            className={`flex size-7 shrink-0 items-center justify-center transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.94] touch:size-11 ${round} ${wide ? "col-start-5 row-start-2" : "col-start-5 row-start-1"}`}
            style={{
              background: canSend ? "var(--accent)" : "var(--line-strong)",
              color: canSend ? "white" : "var(--ink-2)",
            }}
          >
            <Icon size={16} strokeWidth={2.4}><path d="M12 19V5M5 12l7-7 7 7" /></Icon>
          </button>
        </div>
      </div>
      </div>
    </div>
  );
}
