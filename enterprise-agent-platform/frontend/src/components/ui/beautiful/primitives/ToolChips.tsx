/* Adapted from Beautiful UI components/primitives/ToolChips.tsx (MIT, see ../NOTICE).
 * Adaptations: rows and file-diff chips carry the caller's real tool calls instead of the demo script and step
 * timer; a row shows a progress ring while its tool runs and a warning mark plus label when it failed or stopped;
 * expanded rows show the tool's real arguments and output; labels come from the caller (i18n). Markup, classes
 * and motion are upstream's. */
import { useState, type ReactNode, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";

/* ─────────────────────────────────────────────────────────
 * TOOL CHIPS
 * An agent run as compact rows: tool calls with inline
 * chips, then file-diff chips summarizing the edits.
 * Hover a row to reveal its chevron; every row expands
 * to show what the tool actually did.
 * ───────────────────────────────────────────────────────── */

const Icons: Record<string, ReactNode> = {
  think: <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />,
  write: <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></g>,
  run: <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 17l6-5-6-5M12 19h8" /></g>,
  read: <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></g>,
  search: <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></g>,
  web: <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" /></g>,
  tool: <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" /></g>,
};

export type ToolDetailLine = { text: string; tone?: "add" | "del" | "error" | "muted" };

export type ToolStep = {
  id: string;
  icon: keyof typeof Icons | string;
  label: string;
  chip: string;
  mono: boolean;
  detailMono: boolean;
  detail: ToolDetailLine[];
  state: "running" | "done" | "error" | "cancelled";
  /** status text read next to the chip when not done, e.g. "Failed" */
  stateLabel?: string;
};

export type ToolDiff = { file: string; add: number; del: number };

export type ToolDiffLine = { text: string; tone: "add" | "del" | "ctx" };

export type ToolChipsLabels = {
  header: string;
  showDiff: (file: string) => string;
};

const DETAIL_TONE = { add: "text-green", del: "text-red", error: "text-red", muted: "text-ink-2" } as const;

function RunningRing() {
  return (
    <span
      aria-hidden
      className="size-3 shrink-0 rounded-full border-[1.5px] border-line-strong border-t-ink-2"
      style={{ animation: "spin 700ms linear infinite" }}
    />
  );
}

export default function ToolChips({
  steps,
  diffs = [],
  diffLines = {},
  labels,
  className,
  onOpenChange,
  onToggleRow,
}: {
  steps: ToolStep[];
  diffs?: ToolDiff[];
  diffLines?: Record<string, ToolDiffLine[]>;
  labels: ToolChipsLabels;
  className?: string;
  onOpenChange?: (open: boolean) => void;
  onToggleRow?: (id: string, open: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  /* Rendered in a body portal so animated/translated reply wrappers cannot
   * redefine the fixed-position coordinate system. */
  const [preview, setPreview] = useState<{
    file: string;
    x: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  const openPreview = (file: string) => (event: SyntheticEvent) => {
    const rect = (event.currentTarget as Element).closest("[data-diffchip]")!.getBoundingClientRect();
    const previewHeight = 38 + (diffLines[file]?.length ?? 0) * 19;
    const fitsBelow = rect.bottom + 6 + previewHeight <= window.innerHeight - 12;
    setPreview({
      file,
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 300)),
      ...(fitsBelow
        ? { top: rect.bottom + 6 }
        : { bottom: window.innerHeight - rect.top + 6 }),
    });
  };
  const closePreview = (file: string) => () =>
    setPreview((current) => (current?.file === file ? null : current));

  const toggleRow = (id: string) =>
    setOpenRows((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onToggleRow?.(id, next.has(id));
      return next;
    });

  const previewDiff = preview ? diffs.find((diff) => diff.file === preview.file) : undefined;

  return (
    <div className={`w-full max-w-[520px] pb-1${className ? ` ${className}` : ""}`}>
      {/* collapsed run header */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() =>
          setOpen((current) => {
            onOpenChange?.(!current);
            return !current;
          })
        }
        className="-mx-1.5 flex w-fit items-center gap-1.5 rounded-control px-1.5 py-1 text-[12.5px] text-ink-2 transition-colors duration-100 hover:bg-hover-2 pointer-coarse:min-h-11 max-sm:min-h-11"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform duration-200" style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }} aria-hidden>
          <path d="M6 9l6 6 6-6" />
        </svg>
        <span className="tabular-nums">{labels.header}</span>
      </button>

      {/* tool call rows */}
      <div className="grid transition-[grid-template-rows,opacity] duration-300" style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }} inert={!open}>
        {/* -mx-1 + px-1.5 keeps content at the same x while giving the
            row hover pills room inside this overflow-hidden clip box */}
        <div className="-mx-1 min-h-0 overflow-hidden px-1.5 pb-1">
        <div className="mt-1.5 flex flex-col gap-1">
          {steps.map((row) => {
            const rowOpen = openRows.has(row.id);
            const hasDetail = row.detail.length > 0;
            return (
            <div key={row.id} style={{ animation: "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both" }}>
              <button
                type="button"
                aria-expanded={hasDetail ? rowOpen : undefined}
                disabled={!hasDetail}
                onClick={() => toggleRow(row.id)}
                className="group/row -mx-[3px] flex h-7 w-[calc(100%+6px)] min-w-0 items-center gap-2 rounded-control px-[3px] text-left transition-colors duration-100 enabled:hover:bg-hover-2 pointer-coarse:h-11 max-sm:h-11"
              >
                <span className="relative flex size-4 shrink-0 items-center justify-center text-ink-3">
                  {row.state === "running" ? (
                    <RunningRing />
                  ) : row.state === "error" || row.state === "cancelled" ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={row.state === "error" ? "var(--red)" : "currentColor"} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                      className={`transition-opacity duration-100 group-enabled/row:group-hover/row:opacity-0 ${rowOpen ? "opacity-0" : ""}`} aria-hidden>
                      <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                    </svg>
                  ) : (
                    <svg
                      width="13" height="13" viewBox="0 0 24 24" fill={row.icon === "think" ? "currentColor" : "none"} stroke="currentColor"
                      className={`transition-opacity duration-100 group-enabled/row:group-hover/row:opacity-0 ${rowOpen ? "opacity-0" : ""}`} aria-hidden
                    >
                      {Icons[row.icon] ?? Icons.tool}
                    </svg>
                  )}
                  {hasDetail && row.state !== "running" && (
                    <svg
                      width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                      className={`absolute transition-[opacity,transform] duration-150 group-hover/row:opacity-100 ${rowOpen ? "opacity-100" : "opacity-0"}`}
                      style={{ transform: rowOpen ? "rotate(0deg)" : "rotate(-90deg)" }}
                      aria-hidden
                    >
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  )}
                </span>
                <span className="shrink-0 text-[12.5px] font-medium text-ink">{row.label}</span>
                {row.chip && (
                  <span
                    className={`inline-flex h-5.5 min-w-0 flex-1 items-center truncate rounded-chip bg-field px-1.5
                      text-[11.5px] text-ink-2 shadow-hairline transition-colors duration-100 group-enabled/row:group-hover/row:bg-hover-2
                      ${row.mono ? "font-mono" : ""}`}
                  >
                    <span className="truncate">{row.chip}</span>
                  </span>
                )}
                {row.stateLabel && (
                  <span className={`shrink-0 text-[11.5px] font-medium ${row.state === "error" ? "text-red" : "text-ink-2"}`}>{row.stateLabel}</span>
                )}
              </button>

              {/* expanded detail */}
              {hasDetail && (
              <div
                className="grid transition-[grid-template-rows,opacity] duration-300"
                style={{ gridTemplateRows: rowOpen ? "1fr" : "0fr", opacity: rowOpen ? 1 : 0, transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)" }}
                inert={!rowOpen}
              >
                <div className="min-h-0 overflow-hidden">
                  <div className="mt-0.5 mb-1 ml-2 flex max-h-72 flex-col gap-0.5 overflow-y-auto border-l border-line py-0.5 pl-3.5" tabIndex={rowOpen ? 0 : -1}>
                    {row.detail.map((line, index) => (
                      <span
                        key={index}
                        className={`text-[11.5px] leading-[1.6] whitespace-pre-wrap [overflow-wrap:anywhere] ${row.detailMono ? "font-mono" : ""} ${line.tone ? DETAIL_TONE[line.tone] : "text-ink-2"}`}
                      >
                        {line.text}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              )}
            </div>
            );
          })}
        </div>

      {/* file-diff chips */}
      {diffs.length > 0 && (
        <div className="mt-2.5 flex max-w-full flex-wrap gap-1.5 border-t border-line pt-2.5">
          {diffs.map((d, i) => (
            <span
              key={d.file}
              data-diffchip
              className="relative max-w-full"
              onMouseEnter={openPreview(d.file)}
              onMouseLeave={closePreview(d.file)}
            >
              <button
                type="button"
                aria-expanded={preview?.file === d.file}
                aria-label={labels.showDiff(d.file)}
                onFocus={openPreview(d.file)}
                onBlur={closePreview(d.file)}
                className="inline-flex h-7 max-w-full items-center gap-2 rounded-chip
                  bg-surface px-2 font-mono text-[11.5px] text-ink shadow-btn
                  transition-colors duration-100 hover:bg-hover pointer-coarse:h-11 max-sm:h-11"
                style={{ animation: `pop-in 250ms cubic-bezier(0.23,1,0.32,1) ${i * 80}ms both` }}
              >
                <span className="min-w-0 truncate">{d.file}</span>
                <span className="shrink-0 text-green tabular-nums">+{d.add}</span>
                {d.del > 0 && <span className="shrink-0 text-red tabular-nums">−{d.del}</span>}
              </button>
            </span>
          ))}
        </div>
      )}
        </div>
      </div>
      {preview && typeof document !== "undefined" && createPortal(
        <div
          className="fixed z-50 w-72 overflow-hidden rounded-[10px] bg-surface shadow-overlay"
          style={{
            left: preview.x,
            top: preview.top,
            bottom: preview.bottom,
            animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both",
            transformOrigin: preview.top === undefined ? "bottom left" : "top left",
          }}
        >
          <div className="flex items-center justify-between border-b border-line px-2.5 py-1.5 font-mono text-[11px]">
            <span className="min-w-0 truncate text-ink-2">{preview.file}</span>
            <span className="shrink-0 tabular-nums">
              <span className="text-green">+{previewDiff?.add}</span>
              {(previewDiff?.del ?? 0) > 0 && <span className="text-red"> −{previewDiff?.del}</span>}
            </span>
          </div>
          <div className="py-1 font-mono text-[11px] leading-[1.8]">
            {(diffLines[preview.file] ?? []).map((line, index) => (
              <div
                key={index}
                className={`flex gap-2 px-2.5 whitespace-pre ${
                  line.tone === "add"
                    ? "bg-green-tint text-green"
                    : line.tone === "del"
                      ? "bg-red-tint text-red"
                      : "text-ink-2"
                }`}
              >
                <span className="w-3 shrink-0 select-none">{line.tone === "add" ? "+" : line.tone === "del" ? "−" : " "}</span>
                <span className="min-w-0 truncate">{line.text}</span>
              </div>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
