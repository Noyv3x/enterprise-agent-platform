/* Beautiful UI — components/primitives/SearchList.tsx (MIT, see ../LICENSE and ../NOTICE).
 * Adapted: demo flavors replaced by caller items with ids and an `onPick` callback; labels are required (i18n);
 * the clear button is labelled by the caller; the 5-row idle preview is a `limit` prop; hint text uses ink-2 for
 * 4.5:1. The query matcher is exported so the sidebar's chat search filters exactly like this list. */
import { useState } from "react";
import GlideMenu from "./GlideMenu";

export type SearchItem = { id: string; label: string };

export type SearchListLabels = {
  placeholder: string;
  ariaLabel: string;
  clear: string;
  emptyTitle: string;
  emptyHint: string;
};

/** Case-insensitive substring match, as upstream filters. */
export function matchesQuery(label: string, query: string): boolean {
  return label.toLowerCase().includes(query.trim().toLowerCase());
}

export default function SearchList({
  items,
  labels,
  onPick,
  limit = 5,
  className = "",
}: {
  items: SearchItem[];
  labels: SearchListLabels;
  onPick: (item: SearchItem) => void;
  /** rows shown before the user types */
  limit?: number;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const results = query ? items.filter((item) => matchesQuery(item.label, query)) : items.slice(0, limit);
  const empty = query.trim().length > 0 && results.length === 0;

  return (
    <div className={`flex w-full flex-col items-stretch ${className}`}>
      <div className="w-full self-start overflow-hidden rounded-card bg-surface shadow-raised">
        {/* input row */}
        <div className="flex h-10 items-center gap-2 border-b border-line px-3 transition-colors duration-100 hover:bg-hover">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-2)" strokeWidth="2" strokeLinecap="round" className="shrink-0" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={labels.placeholder}
            aria-label={labels.ariaLabel}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-2"
          />
          {query && (
            <button
              aria-label={labels.clear}
              type="button"
              onClick={() => setQuery("")}
              className="flex size-6 items-center justify-center rounded-full text-ink-2
                transition-colors duration-100 hover:bg-line/70 hover:text-ink"
              style={{ animation: "fade-in 150ms ease-out both" }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* results / empty state */}
        {empty ? (
          <div className="flex flex-col items-center justify-center gap-1 px-4 py-8" style={{ animation: "fade-in 250ms ease-out both" }}>
            <span className="mb-1.5 flex size-8 items-center justify-center rounded-control bg-inset text-ink-2 shadow-hairline">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
            </span>
            <span className="text-[13px] font-medium text-ink">{labels.emptyTitle}</span>
            <span className="text-[12px] text-ink-2">{labels.emptyHint}</span>
          </div>
        ) : (
          <div className="p-1">
            <GlideMenu className="flex flex-col gap-px" highlightClassName="inset-x-0 rounded-[6px] bg-hover">
              {results.map((item) => (
                <button
                  key={item.id}
                  data-menu-row
                  type="button"
                  onClick={() => onPick(item)}
                  className="relative z-10 flex h-8 w-full items-center rounded-[6px] px-2 text-left text-[13px] text-ink"
                  style={{ animation: "fade-in 200ms ease-out both" }}
                >
                  <span className="truncate">{item.label}</span>
                </button>
              ))}
            </GlideMenu>
          </div>
        )}
      </div>
    </div>
  );
}
