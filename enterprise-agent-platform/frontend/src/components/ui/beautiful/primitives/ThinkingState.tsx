/* Adapted from Beautiful UI components/primitives/ThinkingState.tsx (MIT, see ../NOTICE).
 * Adaptations: the scripted stage timer is replaced by the caller's real `working` state; the trace body is the
 * caller's ordered work (reasoning prose, step rows, tool chips) instead of demo rows; the gallery's reserved
 * min-height is dropped; the trace line follows content growth while streaming. Accessibility: the header button is
 * named by its status text, and the working shimmer sweeps between ink-2 and ink so the label keeps 4.5:1 contrast.
 * Markup, classes and motion are upstream's. */
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

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
  return (
    <div className={ROW} style={{ animation: "fade-up 320ms cubic-bezier(0.23,1,0.32,1) both" }}>
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

/** A Reasoning-variant row: prose that wraps, in the secondary ink. */
export function TraceProse({ children }: { children: ReactNode }) {
  return (
    <div className={`${ROW} items-start`} style={{ animation: "fade-up 320ms cubic-bezier(0.23,1,0.32,1) both" }}>
      <div className="min-w-0 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">{children}</div>
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
  const traceRef = useRef<HTMLDivElement>(null);
  const [lineHeight, setLineHeight] = useState(0);
  useLayoutEffect(() => {
    const trace = traceRef.current;
    if (!trace) return;
    const measure = () => setLineHeight(trace.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(trace);
    return () => observer.disconnect();
  }, []);

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
              style={{ animation: "fade-in 350ms ease-out both" }}
            >
              {done}
            </span>
          )}
        </span>
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
          className="shrink-0 transition-transform duration-300"
          style={{ transform: expanded ? "rotate(180deg)" : "rotate(0)" }}
          aria-hidden
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {/* expandable trace */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-400"
        style={{
          gridTemplateRows: expanded ? "1fr" : "0fr",
          opacity: expanded ? 1 : 0,
          transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
        }}
        inert={!expanded}
      >
        <div className="overflow-hidden">
          <div className="relative mt-1 ml-[5px] pl-4">
            <span
              aria-hidden
              className="absolute left-[3px] w-px bg-line"
              style={{ top: -8, height: lineHeight ? lineHeight - 2 : 0, transition: "height 500ms cubic-bezier(0.23,1,0.32,1)" }}
            />
            <div ref={traceRef} className="flex flex-col gap-1 py-1">
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
