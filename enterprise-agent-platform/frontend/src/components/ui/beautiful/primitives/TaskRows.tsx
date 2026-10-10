/* Adapted from Beautiful UI components/primitives/TaskRows.tsx (MIT, see ../LICENSE and ../NOTICE).
 * Adaptations: the demo tick sequence is replaced by a real `status` per row (done / running / failed /
 * pending / idle) with an optional `pill` override and an optional expanded `children` slot for actions;
 * rows may be controlled (`open`/`onToggleRow`); labels come from the caller's i18n; the failed pill's
 * retry glyph is static because nothing retries automatically. A row with `onSelect` (the personal AI's
 * background tasks) opens something else instead of expanding: the same row button, its chevron turned to
 * point right, no detail and no `aria-expanded`. In a narrow container the caller may add `task-rows-stacked`
 * to `className` so the amount sits under the label, as it already does on narrow windows (task-rows.css). */
import { useId, useState, type ReactNode } from "react";
import "./task-rows.css";

/** The row's step ring: a resting hairline ring, or a rotating arc while `active`. */
export function SpinnerRing({ active, children }: { active?: boolean; children?: ReactNode }) {
  const size = 24, stroke = 2;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg
        width={size} height={size} className="absolute inset-0" aria-hidden
        style={active ? { animation: "spin 1.1s linear infinite" } : undefined}
      >
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
        {active && (
          <circle
            cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke="var(--ink-3)" strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={`${c * 0.28} ${c * 0.72}`}
          />
        )}
      </svg>
      <span className="relative text-[10.5px] font-semibold tabular-nums text-ink">{children}</span>
    </span>
  );
}

function Badge({ tone, children }: { tone: "red" | "green"; children: ReactNode }) {
  return (
    <span
      className={`flex size-5.5 shrink-0 items-center justify-center rounded-full text-white
        ${tone === "red" ? "bg-red" : "bg-green"}`}
      style={{ animation: "pop-in 300ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      {children}
    </span>
  );
}

const XIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" aria-hidden><path d="M18 6L6 18M6 6l12 12" /></svg>
);
const CheckIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6L9 17l-5-5" /></svg>
);
const RetryIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" /></svg>
);

/* One detail line shown when a task row is expanded. */
export type TaskDetail = { label: string; meta: ReactNode; wide?: boolean };

export type TaskStatus = "done" | "running" | "failed" | "pending" | "idle";
export type TaskPillTone = "green" | "red" | "orange" | "neutral" | "accent";

/* A single task row.
 *  - "done"    → green check badge + completed pill
 *  - "running" → active spinner showing `step`, no pill
 *  - "failed"  → red cross badge + failed pill
 *  - "pending" → resting ring showing `step`
 *  - "idle"    → resting ring, no pill
 * `pill` replaces the default pill (null hides it). */
export type TaskRow = {
  key: string;
  label: string;
  amount?: ReactNode;
  status: TaskStatus;
  step?: ReactNode;
  pill?: { tone: TaskPillTone; label: string } | null;
  details: TaskDetail[];
  /** Extra expanded content under the detail lines (actions, notes). */
  children?: ReactNode;
  /** Selecting the row opens something else; the row does not expand. */
  onSelect?: () => void;
};

export type TaskRowsLabels = {
  completed: string;
  failed: string;
};

const DEFAULT_LABELS: TaskRowsLabels = {
  completed: "Completed",
  failed: "Failed",
};

const PILL_TONES: Record<TaskPillTone, string> = {
  green: "bg-green-tint text-green-ink",
  red: "bg-red-tint text-red-ink",
  orange: "bg-orange-tint text-orange-ink",
  neutral: "bg-field text-ink-2",
  accent: "bg-accent-tint text-accent-ink",
};

export default function TaskRows({
  variant = "Capsules",
  rows,
  labels,
  className,
  open: controlledOpen,
  onToggleRow,
  ariaLabel,
}: {
  variant?: "Capsules" | "List";
  rows: TaskRow[];
  labels?: Partial<TaskRowsLabels>;
  className?: string;
  /** Controlled expansion; omit to let rows expand on their own. */
  open?: Record<string, boolean>;
  onToggleRow?: (key: string, open: boolean) => void;
  ariaLabel?: string;
}) {
  const idPrefix = useId();
  const [manualOpen, setManualOpen] = useState<Record<string, boolean>>({});
  const copy = { ...DEFAULT_LABELS, ...labels };
  const openState = controlledOpen ?? manualOpen;

  const badgeFor = (row: TaskRow) => {
    if (row.status === "done") return <Badge tone="green">{CheckIcon}</Badge>;
    if (row.status === "failed") return <Badge tone="red">{XIcon}</Badge>;
    if (row.status === "running") return <SpinnerRing active>{row.step}</SpinnerRing>;
    return <SpinnerRing>{row.step}</SpinnerRing>;
  };

  const pillFor = (row: TaskRow) => {
    if (row.pill === null) return null;
    if (row.pill) {
      return (
        <span className={`inline-flex h-5.5 shrink-0 items-center whitespace-nowrap rounded-full px-2 text-[11.5px] font-medium ${PILL_TONES[row.pill.tone]}`}>
          {row.pill.label}
        </span>
      );
    }
    if (row.status === "done")
      return (
        <span className="inline-flex h-5.5 shrink-0 items-center whitespace-nowrap rounded-full bg-green-tint px-2 text-[11.5px] font-medium text-green-ink">
          {copy.completed}
        </span>
      );
    if (row.status === "failed")
      return (
        <span className="inline-flex h-5.5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-red-tint px-2 text-[11.5px] font-medium text-red-ink" style={{ animation: "fade-in 200ms ease-out both" }}>
          {copy.failed} <span className="flex">{RetryIcon}</span>
        </span>
      );
    return null;
  };

  const list = variant === "List";
  return (
    <div
      role="list"
      aria-label={ariaLabel}
      className={`task-rows flex w-full flex-col ${
        list ? "gap-0 self-start overflow-hidden rounded-card bg-surface shadow-card" : "gap-2"
      }${className ? ` ${className}` : ""}`}
    >
      {rows.map((row, i) => {
        const open = !row.onSelect && (openState[row.key] ?? false);
        const detailId = `${idPrefix}-task-row-${row.key}-detail`;
        return (
          <div
            key={row.key}
            role="listitem"
            className={`self-stretch overflow-hidden transition-[border-radius,background-color] duration-300 hover:bg-inset ${
              list ? "border-b border-line last:border-0" : "bg-surface shadow-card"
            }`}
            style={{
              borderRadius: list ? 0 : open ? 14 : 22,
              animation: `fade-up 450ms cubic-bezier(0.23,1,0.32,1) ${Math.min(i, 8) * 80}ms both`,
            }}
          >
            <button
              type="button"
              aria-expanded={row.onSelect ? undefined : open}
              aria-controls={row.onSelect ? undefined : detailId}
              onClick={() => {
                if (row.onSelect) {
                  row.onSelect();
                  return;
                }
                if (!controlledOpen) setManualOpen((current) => ({ ...current, [row.key]: !open }));
                onToggleRow?.(row.key, !open);
              }}
              className="task-row-button flex min-h-11 w-full items-center gap-2.5 px-2.5 text-left"
            >
              <span className="flex size-6 shrink-0 items-center justify-center">
                {badgeFor(row)}
              </span>
              <span className="task-row-text flex min-w-0 flex-1 items-center gap-2.5">
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                  {row.label}
                </span>
                {row.amount !== undefined && <span className="task-row-amount truncate text-[12.5px] text-ink-2 tabular-nums">{row.amount}</span>}
              </span>
              {pillFor(row)}
              <span
                aria-hidden="true"
                className="-ml-2 flex size-7 shrink-0 items-center justify-center rounded-full text-ink-2"
              >
                <svg
                  width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                  className="transition-transform duration-300"
                  style={{ transform: row.onSelect ? "rotate(-90deg)" : open ? "rotate(180deg)" : "rotate(0)" }}
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </span>
            </button>

            {/* dropdown detail — same expandable grammar as Chain of Thought */}
            {!row.onSelect && <div
              id={detailId}
              className="grid transition-[grid-template-rows,opacity] duration-300"
              style={{
                gridTemplateRows: open ? "1fr" : "0fr",
                opacity: open ? 1 : 0,
                transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
              }}
              inert={!open}
            >
              <div className="overflow-hidden">
                <div className="mb-2.5 grid grid-cols-[24px_1fr] gap-2.5 px-2.5">
                  <span aria-hidden className="mx-auto h-full w-px bg-line" />
                  <div className="flex min-w-0 flex-col gap-1.5">
                    {row.details.map((d, j) => (
                      <div
                        key={d.label}
                        className={d.wide ? "flex flex-col gap-0.5" : "flex items-center justify-between gap-3"}
                        style={
                          open
                            ? { animation: `fade-up 300ms cubic-bezier(0.23,1,0.32,1) ${120 + j * 100}ms both` }
                            : undefined
                        }
                      >
                        <span className="text-[12px] text-ink-2">{d.label}</span>
                        <span className={d.wide ? "whitespace-pre-wrap break-words text-[12px] text-ink" : "min-w-0 truncate text-right font-mono text-[11.5px] text-ink-2 tabular-nums"}>
                          {d.meta}
                        </span>
                      </div>
                    ))}
                    {row.children}
                  </div>
                </div>
              </div>
            </div>}
          </div>
        );
      })}
    </div>
  );
}
