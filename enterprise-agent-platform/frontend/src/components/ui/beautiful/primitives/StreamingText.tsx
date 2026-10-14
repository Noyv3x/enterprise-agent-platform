/* Adapted from Beautiful UI components/primitives/StreamingText.tsx (MIT, see ../NOTICE).
 * Adaptations: the answer is the caller's real (Markdown) content as it streams instead of a timed token script,
 * with StreamText's caret (`stream-caret`) at the live edge; the action row carries real actions (copy, resend)
 * and a status slot; inline citation chips and follow-up prompts are removed because replies carry none. The action
 * row keeps upstream's icon buttons and its fade-in when the stream settles; a reply that was already settled when it
 * mounted (restored history) shows the row in place, without replaying that entrance.
 * Sources: upstream's avatar stack, count toggle and expandable source list are restored for the pages the AI read
 * (`sources`, after the answer settles). Each avatar is the Monogram atom (the site's generated initial and tone)
 * instead of an image, so nothing is requested from a third party; the stack's ring uses the reply's ground (page);
 * the list's site names are ink-2 (upstream ink-3) and its rows and the toggle are 44px on coarse pointers and narrow
 * screens; the toggle names the list it controls, which is inert while collapsed; links open a new tab without a
 * referrer. */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Monogram } from "../atoms/EntityChip";
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

/** one page the answer drew on: listed under the reply, its avatar a generated monogram */
export type StreamingSource = { name: string; domain: string; href: string; letter: string; color: string };

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
  sources = [],
  sourcesLabel = "",
  fill = true,
}: {
  /** the answer is still arriving; actions wait until it settles */
  streaming: boolean;
  /** the rendered answer; place `<span className="stream-caret is-streaming" />` at its live edge */
  children?: ReactNode;
  actions?: StreamingAction[];
  /** run status shown at the start of the action row (e.g. an interrupted pill) */
  status?: ReactNode;
  /** the pages the answer drew on, shown once it settles */
  sources?: StreamingSource[];
  /** the sources toggle, e.g. "3 sources" */
  sourcesLabel?: string;
  /** fill the parent width instead of the gallery's fixed measure */
  fill?: boolean;
}) {
  const showRow = !streaming && (actions.length > 0 || status || sources.length > 0);
  const [streamed, setStreamed] = useState(streaming);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const listId = useId();
  if (streaming && !streamed) setStreamed(true);
  const listOpen = sourcesOpen && !streaming;
  return (
    <div className={fill ? "w-full" : "w-full max-w-95"}>
      {children && <div className="bui-prose text-[13.5px] leading-[1.65] text-ink">{children}</div>}

      {/* action icons row */}
      {showRow && (
        <div
          className={`${children ? "mt-2" : ""} flex flex-wrap items-center gap-0.5`}
          style={{ animation: streamed ? "fade-in 400ms ease-out both" : undefined }}
        >
          {status && <span className="mr-1.5 flex items-center gap-1.5">{status}</span>}
          {actions.map((action) => <ActionButton key={action.key} action={action} />)}
          {sources.length > 0 && (
            <button
              type="button"
              aria-expanded={listOpen}
              aria-controls={listId}
              onClick={() => setSourcesOpen((current) => !current)}
              className="ml-1.5 flex items-center gap-1.5 rounded-[6px] px-1 py-0.5 text-left transition-colors duration-150 hover:bg-hover pointer-coarse:min-h-11 max-sm:min-h-11"
            >
              <span aria-hidden className="flex -space-x-1">
                {sources.slice(0, 4).map((source) => (
                  <Monogram key={source.href} color={source.color} className="size-3.5 text-[7.5px] shadow-[0_0_0_1.5px_var(--page)]">{source.letter}</Monogram>
                ))}
              </span>
              <span className="text-[12px] text-ink-2">{sourcesLabel}</span>
            </button>
          )}
        </div>
      )}

      {sources.length > 0 && !streaming && (
        <div
          id={listId}
          className="grid max-w-[520px] transition-[grid-template-rows,opacity] duration-300 ease-out-strong"
          style={{ gridTemplateRows: listOpen ? "1fr" : "0fr", opacity: listOpen ? 1 : 0 }}
          inert={!listOpen}
        >
          <div className="min-h-0 overflow-hidden">
            <ul className="mt-1.5 flex flex-col rounded-[10px] bg-inset p-1 shadow-hairline">
              {sources.map((source) => (
                <li key={source.href}>
                  <a
                    href={source.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 rounded-[6px] px-1.5 py-1 text-[12px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink pointer-coarse:min-h-11 max-sm:min-h-11"
                  >
                    <Monogram color={source.color} className="size-4 rounded-[4px]">{source.letter}</Monogram>
                    <span className="min-w-0 truncate"><span className="animated-underline">{source.name}</span></span>
                    <span className="ml-auto shrink-0 font-mono text-[10.5px] text-ink-2">{source.domain}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
