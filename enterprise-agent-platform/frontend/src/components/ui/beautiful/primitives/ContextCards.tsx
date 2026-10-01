/* Adapted from Beautiful UI components/primitives/ContextCards.tsx (MIT, see ../NOTICE).
 * Adaptations: each card is a real file (message attachment or delivered `MEDIA:` file) instead of a retrieved
 * demo chunk: the bar names the file and its size, the body holds the caller's preview (image thumbnail or an
 * on-request document preview), and the source chip is the authorized download link; the header is optional;
 * the chip's entrance delay timer is dropped. Markup, classes and motion are upstream's. */
import type { ReactNode } from "react";

/* ─────────────────────────────────────────────────────────
 * CONTEXT CARDS
 * Files enter once, then remain available.
 * ───────────────────────────────────────────────────────── */

export type ContextFile = {
  key: string | number;
  title: string;
  /** e.g. "12.4 KB" */
  chars: string;
  /** preview body (image, document frame); omitted when the format has none */
  body?: ReactNode;
  /** short type badge, e.g. "PDF" */
  badge: string;
  /** badge color class, e.g. "bg-red" */
  tone: string;
  href: string;
  /** accessible name of the download chip */
  downloadLabel: string;
  /** extra chips next to the download chip (e.g. a preview toggle) */
  actions?: ReactNode;
};

export type ContextCardsLabels = {
  header: string;
  count: string;
};

/** Upstream's source-chip look, for secondary chips placed in a card's `actions`. */
export const CONTEXT_CHIP = `inline-flex h-6 items-center gap-1.5 rounded-full bg-inset px-2
  text-[12px] font-medium text-ink-2 shadow-btn transition-[background-color] duration-300 hover:bg-hover
  pointer-coarse:h-11 max-sm:h-11`;

export default function ContextCards({
  files,
  labels,
  className,
}: {
  files: ContextFile[];
  labels?: ContextCardsLabels;
  className?: string;
}) {
  return (
    <div className={`flex w-full max-w-95 flex-col gap-2${className ? ` ${className}` : ""}`}>
      {labels && (
        <div
          className="flex items-center gap-2 px-0.5"
          style={{ animation: "fade-in 400ms ease-out both" }}
        >
          <span className="text-[13px] font-semibold text-ink">{labels.header}</span>
          <span className="inline-flex h-5 items-center rounded-md bg-inset px-1.5 text-[11.5px] font-medium text-ink-2 shadow-hairline tabular-nums">
            {labels.count}
          </span>
        </div>
      )}

      {files.map((file, i) => (
        <div
          key={file.key}
          className="overflow-hidden rounded-card bg-surface shadow-card"
          style={{
            animation: `fade-up 400ms cubic-bezier(0.23,1,0.32,1) ${i * 100}ms both`,
          }}
        >
          <div className="primitive-card-bar flex items-center gap-2.5 border-b border-line">
            <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-ink">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden className="shrink-0"><path d="M4 6h16M4 12h16M4 18h10" /></svg>
              <span className="truncate" title={file.title}>{file.title}</span>
            </span>
            <span className="ml-auto shrink-0 text-[12px] text-ink-2 tabular-nums">{file.chars}</span>
          </div>
          {file.body && (
            <div className="px-3 pt-2 pb-1 text-[12.5px] leading-relaxed text-ink-2">
              {file.body}
            </div>
          )}
          <div className={`flex flex-wrap items-center gap-1.5 px-3 pb-3 ${file.body ? "" : "pt-2.5"}`}>
            <a
              href={file.href}
              download={file.title}
              aria-label={file.downloadLabel}
              className={`${CONTEXT_CHIP} max-w-full`}
              style={{ transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)" }}
            >
              <span aria-hidden className={`flex size-3.5 shrink-0 items-center justify-center rounded-[4px] ${file.tone} text-[7px] font-bold text-white`}>
                {file.badge}
              </span>
              <span className="truncate">{file.title}</span>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0"><path d="M12 4v12M6 11l6 6 6-6M5 20h14" /></svg>
            </a>
            {file.actions}
          </div>
        </div>
      ))}
    </div>
  );
}
