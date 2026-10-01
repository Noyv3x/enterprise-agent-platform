/* Adapted from Beautiful UI components/primitives/FilterTable.tsx (MIT, see ../LICENSE and ../NOTICE).
 * Adaptations: demo rows/filters become props — `filters` (key, label, dot tone, count), `columns` (label,
 * fr width, alignment, cell renderer) and `rows` with a `matches` predicate; the status chip bar is also
 * exported alone (`FilterChips`) for lists that render their rows elsewhere; the active filter can be
 * controlled; the width follows the container instead of the gallery's fixed 420px; status pills keep the
 * upstream `filter-status-*` colors through `FilterStatusPill`. */
import { useState, type ReactNode } from "react";
import "./filter-table.css";

export type FilterTone = "todo" | "progress" | "done" | "failed" | "neutral";

/* the dots use the same base hues as the status pills below */
const DOTS: Record<FilterTone, string> = {
  todo: "#f09a2f",
  progress: "#16a6c7",
  done: "#25a878",
  failed: "oklch(0.64 0.19 27)",
  neutral: "var(--ink-3)",
};

export type FilterOption<K extends string = string> = { key: K; label: string; tone?: FilterTone; count: number };

export function FilterChips<K extends string>({
  filters,
  value,
  onChange,
  label,
  className = "",
}: {
  filters: FilterOption<K>[];
  value: K;
  onChange: (key: K) => void;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`filter-chips -mx-1 mb-1 flex items-center gap-1 overflow-x-auto px-1 py-1 ${className}`}
      style={{ scrollbarWidth: "none" }}
    >
      {filters.map((f) => {
        const active = value === f.key;
        return (
          <button
            key={f.key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(f.key)}
            className={`filter-chip flex h-6.5 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px]
              font-medium transition-[background-color,box-shadow,color] duration-200
              ${active ? "bg-surface text-ink shadow-btn" : "text-ink-2 hover:bg-hover"}`}
          >
            {f.tone && <span className="size-1.5 rounded-full" style={{ background: DOTS[f.tone] }} />}
            {f.label}
            <span
              className={`rounded-[4px] px-1 text-[10.5px] tabular-nums
                ${active ? "bg-field text-ink-2" : "text-ink-2"}`}
            >
              {f.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The table's status pill, in the upstream electric colors. */
export function FilterStatusPill({ tone, children }: { tone: FilterTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex h-[23px] shrink-0 items-center whitespace-nowrap rounded-[8px] border px-[7px]
        text-[13px] font-medium filter-status-${tone}`}
    >
      {children}
    </span>
  );
}

export type FilterColumn<T> = {
  key: string;
  label: string;
  /** grid track weight, e.g. 1.3 → minmax(0,1.3fr) */
  width: number;
  align?: "start" | "end";
  /** the primary column renders in ink and medium weight */
  primary?: boolean;
  render: (row: T) => ReactNode;
};

export default function FilterTable<T, K extends string>({
  rows,
  rowKey,
  columns,
  filters,
  matches,
  filter: controlledFilter,
  onFilterChange,
  labels,
  minWidth = 420,
  empty,
  className = "",
}: {
  rows: T[];
  rowKey: (row: T) => string | number;
  columns: FilterColumn<T>[];
  filters: FilterOption<K>[];
  matches: (row: T, filter: K) => boolean;
  filter?: K;
  onFilterChange?: (key: K) => void;
  labels: { filters: string; table: string };
  minWidth?: number;
  empty?: ReactNode;
  className?: string;
}) {
  const [ownFilter, setOwnFilter] = useState<K>(filters[0].key);
  const filter = controlledFilter ?? ownFilter;
  const setFilter = (key: K) => {
    setOwnFilter(key);
    onFilterChange?.(key);
  };
  const template = columns.map((column) => `minmax(0,${column.width}fr)`).join(" ");
  const shownCount = rows.filter((row) => matches(row, filter)).length;

  return (
    <div className={`w-full ${className}`}>
      {/* filter chips */}
      <FilterChips filters={filters} value={filter} onChange={setFilter} label={labels.filters} />

      {/* table */}
      <div
        aria-label={labels.table}
        className="overflow-x-auto rounded-card bg-surface shadow-card"
        role="region"
        tabIndex={0}
        style={{ scrollbarWidth: "none" }}
      >
        <div role="table" aria-label={labels.table} style={{ minWidth }}>
          <div role="row" className="grid border-b border-[var(--grid-line)] text-[12.5px] font-medium text-ink-2" style={{ gridTemplateColumns: template }}>
            {columns.map((column, index) => (
              <span
                key={column.key}
                role="columnheader"
                className={`px-3 py-2 ${index < columns.length - 1 ? "border-r border-[var(--grid-line)]" : ""} ${column.align === "end" ? "text-right" : ""}`}
              >
                {column.label}
              </span>
            ))}
          </div>
          {rows.map((row) => {
            const shown = matches(row, filter);
            return (
              <div
                key={rowKey(row)}
                className="grid transition-[grid-template-rows,opacity] duration-300"
                style={{
                  gridTemplateRows: shown ? "1fr" : "0fr",
                  opacity: shown ? 1 : 0,
                  transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
                }}
                aria-hidden={!shown}
                inert={!shown}
              >
                <div className="overflow-hidden">
                  <div
                    role="row"
                    className="grid border-b border-[var(--grid-line)] text-[13px] transition-colors duration-100 hover:bg-hover"
                    style={{ gridTemplateColumns: template }}
                  >
                    {columns.map((column, index) => {
                      const content = column.render(row);
                      return (
                        <span
                          key={column.key}
                          role="cell"
                          className={`flex min-w-0 items-center px-3 py-2 ${index < columns.length - 1 ? "border-r border-[var(--grid-line)]" : ""} ${
                            column.align === "end" ? "justify-end tabular-nums" : ""
                          } ${column.primary ? "" : "text-ink-2"}`}
                        >
                          {column.primary
                            ? <span className="truncate font-medium text-ink">{content}</span>
                            : typeof content === "string" || typeof content === "number"
                              ? <span className="truncate whitespace-nowrap">{content}</span>
                              : content}
                        </span>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
          {shownCount === 0 && empty && (
            <div className="px-3 py-6 text-center text-[12.5px] text-ink-2">{empty}</div>
          )}
        </div>
      </div>
    </div>
  );
}
