/* Adapted from Beautiful UI components/primitives/ThinkingState.tsx (MIT, see ../NOTICE).
 * Adaptations: the scripted stage timer is replaced by the caller's real `working` state; the trace body is the
 * caller's ordered work (reasoning prose, step rows, tool chips) instead of demo rows; the gallery's reserved
 * min-height is dropped. Accessibility: the header button is named by its status text, and the working shimmer
 * sweeps between ink-2 and ink so the label keeps 4.5:1 contrast.
 * TraceProse accepts Markdown with a per-block heading in secondary ink (no live announcements); TraceThinking
 * reuses the header sparkle as a quiet pulse for an empty live block, with a stable polite label and no motion
 * under reduced motion.
 * Motion: the disclosure is 300ms ease-out-strong (like ToolChips' groups and rows) and its clip box has
 * `min-h-0`, so `0fr` collapses to zero height; the chevron turns on the same timing. The trace line is pinned to
 * the trace box (8px above it to 10px above its end, upstream's endpoints) instead of a measured, animated height,
 * so it follows streamed content without a ResizeObserver. Rows play their fade-up only when new (see ./entrance):
 * rows a settled trace already had at its first render appear in place, and the settled label fades in only after
 * live work in the same trace. The remaining markup, classes and motion are upstream's. */
import { useId, useState, type ReactNode } from "react";
import { EntranceContext, useEntering, useEntranceScope } from "./entrance";
import "./streamingText.css";

/* ─────────────────────────────────────────────────────────
 * THINKING — expandable agent trace
 *
 *   Steps      step list with spinner → muted checks
 *   Reasoning  prose reasoning that expands, then settles
 *
 * The trace runs while the agent works, settles, and remains
 * expandable.
 * ───────────────────────────────────────────────────────── */

const ROW = "flex min-h-7 w-full items-center gap-2 rounded-[6px] px-1.5 py-0.5 text-left";
const ROW_ENTER = "fade-up 320ms cubic-bezier(0.23,1,0.32,1) both";

/** A Steps-variant row: spinner while running, muted check when done, warning mark on failure. */
export function TraceStep({
  primary,
  secondary,
  state = "done",
  mono = false,
}: {
  primary: ReactNode;
  secondary?: ReactNode;
  state?: "running" | "done" | "error";
  mono?: boolean;
}) {
  const entering = useEntering();
  return (
    <div className={ROW} style={{ animation: entering ? ROW_ENTER : undefined }}>
      {state === "running" ? (
        <span className="size-3 shrink-0 rounded-full border-[1.5px] border-line-strong border-t-ink-2" style={{ animation: "spin 700ms linear infinite" }} />
      ) : state === "error" ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--red)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
          <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
          <path d="M20 6L9 17l-5-5" />
        </svg>
      )}
      <span className="min-w-0 truncate text-[12.5px] font-medium text-ink">{primary}</span>
      {secondary && (
        <span className={`min-w-0 truncate text-[11.5px] text-ink-2 ${mono ? "font-mono" : ""}`}>{secondary}</span>
      )}
    </div>
  );
}

/** A Reasoning-variant row: Markdown that wraps, with its optional head in the secondary ink. */
export function TraceProse({ children, heading }: { children: ReactNode; heading?: ReactNode }) {
  const entering = useEntering();
  return (
    <div className={`${ROW} items-start`} aria-live="off" style={{ animation: entering ? ROW_ENTER : undefined }}>
      <div className="min-w-0 w-full text-[12.5px] leading-relaxed text-ink-2 [overflow-wrap:anywhere]">
        {heading && <p className="mb-1 font-medium">{heading}</p>}
        <div className="bui-prose">{children}</div>
      </div>
    </div>
  );
}

/** An empty live reasoning block, kept in place until text arrives or the block ends. */
export function TraceThinking({ label }: { label: string }) {
  return (
    <div className={`${ROW} text-[12.5px] text-ink-2`} role="status" aria-live="polite" aria-atomic="true">
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="size-3 shrink-0 animate-pulse motion-reduce:animate-none">
        <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
      </svg>
      <span>{label}</span>
    </div>
  );
}

export default function ThinkingState({
  working,
  active,
  done,
  icon,
  children,
  onToggle,
}: {
  /** the agent is still producing this trace */
  working: boolean;
  /** header while working, e.g. "Thinking 4s" */
  active: ReactNode;
  /** header once settled, e.g. "Thought for 12s" */
  done: ReactNode;
  /** override the header glyph (defaults to the sparkle) */
  icon?: ReactNode;
  /** the ordered trace */
  children: ReactNode;
  onToggle?: (expanded: boolean) => void;
}) {
  const labelId = useId();
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  /* open while the agent works, settle closed; a reader's choice wins */
  const expanded = manualExpanded ?? working;
  const entrance = useEntranceScope(working);
  /* the settled label fades in when this trace settles, not when a settled trace is restored */
  const [settles, setSettles] = useState(working);
  if (working && !settles) setSettles(true);

  return (
    <div className="flex w-full flex-col">
      {/* header */}
      <button
        type="button"
        aria-expanded={expanded}
        aria-labelledby={labelId}
        onClick={() => {
          const next = !expanded;
          setManualExpanded(next);
          onToggle?.(next);
        }}
        className="-mx-1.5 flex w-fit max-w-full items-center gap-2 rounded-control px-1.5 py-1
          transition-colors duration-100 hover:bg-hover-2 pointer-coarse:min-h-11 max-sm:min-h-11"
      >
        {icon ? (
          <span className="flex shrink-0 transition-colors duration-200" style={{ color: working ? "var(--ink-2)" : "var(--ink-3)" }}>
            {icon}
          </span>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill={working ? "var(--ink-2)" : "var(--ink-3)"} aria-hidden className="shrink-0">
            <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
          </svg>
        )}
        <span id={labelId} role="status" className="contents">
          {working ? (
            <span
              className="bg-clip-text text-[13px] font-medium whitespace-nowrap text-transparent"
              style={{
                backgroundImage:
                  "linear-gradient(90deg, var(--ink-2) 35%, var(--ink) 50%, var(--ink-2) 65%)",
                backgroundSize: "200% 100%",
                animation: "shimmer-text 1.4s linear infinite",
              }}
            >
              {active}
            </span>
          ) : (
            <span
              className="truncate text-[13px] font-medium whitespace-nowrap text-ink-2"
              style={{ animation: settles ? "fade-in 350ms ease-out both" : undefined }}
            >
              {done}
            </span>
          )}
        </span>
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
          className="shrink-0 transition-transform duration-300 ease-out-strong"
          style={{ transform: expanded ? "rotate(180deg)" : "rotate(0)" }}
          aria-hidden
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {/* expandable trace */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300 ease-out-strong"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr", opacity: expanded ? 1 : 0 }}
        inert={!expanded}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="relative mt-1 ml-[5px] pl-4">
            <span aria-hidden className="absolute -top-2 bottom-2.5 left-[3px] w-px bg-line" />
            <div className="flex flex-col gap-1 py-1">
              <EntranceContext value={entrance}>{children}</EntranceContext>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
