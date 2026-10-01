/* Adapted from Beautiful UI components/primitives/StreamingText.tsx (MIT, see ../NOTICE).
 * Adaptations: the answer is the caller's real (Markdown) content as it streams instead of a timed token script,
 * with StreamText's caret (`stream-caret`) at the live edge; the action row carries real actions (copy, resend)
 * and a status slot; demo sources and follow-up prompts are removed because replies carry none. The action row
 * keeps upstream's icon buttons and fade-in once the stream settles. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import "../atoms/stream-text.css";
import "./streamingText.css";

/* ─────────────────────────────────────────────────────────
 * STREAMING TEXT
 * Words arrive at the caret, then actions become usable.
 * ───────────────────────────────────────────────────────── */

const ACTION_ICONS: Record<"copy" | "retry" | "check", ReactNode> = {
  copy: <g><rect x="9" y="9" width="12" height="12" rx="2.5" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></g>,
  retry: <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />,
  check: <path d="M20 6L9 17l-5-5" />,
};

export type StreamingAction = {
  key: string;
  icon: "copy" | "retry";
  label: string;
  /** label announced after a successful run, e.g. "Copied" */
  doneLabel?: string;
  onClick: () => void | Promise<unknown>;
  disabled?: boolean;
};

function ActionButton({ action }: { action: StreamingAction }) {
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const label = done && action.doneLabel ? action.doneLabel : action.label;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={action.disabled}
      onClick={() => {
        void Promise.resolve(action.onClick()).then(() => {
          if (!action.doneLabel) return;
          setDone(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setDone(false), 1500);
        }, () => undefined);
      }}
      className={`flex size-6 items-center justify-center rounded-[6px] transition-colors duration-100
        hover:bg-hover-2 disabled:opacity-50 pointer-coarse:size-11 max-sm:size-11
        ${done ? "text-green" : "text-ink-3 hover:text-ink-2"}`}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {ACTION_ICONS[done ? "check" : action.icon]}
      </svg>
    </button>
  );
}

export default function StreamingText({
  streaming,
  children,
  actions = [],
  status,
  fill = true,
}: {
  /** the answer is still arriving; actions wait until it settles */
  streaming: boolean;
  /** the rendered answer; place `<span className="stream-caret is-streaming" />` at its live edge */
  children?: ReactNode;
  actions?: StreamingAction[];
  /** run status shown at the start of the action row (e.g. an interrupted pill) */
  status?: ReactNode;
  /** fill the parent width instead of the gallery's fixed measure */
  fill?: boolean;
}) {
  const showRow = !streaming && (actions.length > 0 || status);
  return (
    <div className={fill ? "w-full" : "w-full max-w-95"}>
      {children && <div className="bui-prose text-[13.5px] leading-[1.65] text-ink">{children}</div>}

      {/* action icons row */}
      {showRow && (
        <div
          className={`${children ? "mt-2" : ""} flex flex-wrap items-center gap-0.5`}
          style={{ animation: "fade-in 400ms ease-out both" }}
        >
          {status && <span className="mr-1.5 flex items-center gap-1.5">{status}</span>}
          {actions.map((action) => <ActionButton key={action.key} action={action} />)}
        </div>
      )}
    </div>
  );
}
