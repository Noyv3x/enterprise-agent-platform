/* Adapted from Beautiful UI components/primitives/RecordsTable.tsx (MIT, see ../LICENSE and ../NOTICE).
 * Adaptations:
 * - the demo CRM rows and fixed columns become props: a sticky `primary` column (row number, initial mark,
 *   name that opens the row) and `columns` with their own glyph, width, sort and cell renderer;
 * - the AI property popover, "New property" menu and calculating column are demo behaviour and are dropped;
 *   a header click sorts (the arrow shows the direction) and `aria-sort` reports it;
 * - row checkboxes are dropped (no bulk actions), so the spreadsheet gutter keeps its row numbers;
 * - the table options menu keeps Compact columns / Reset column widths;
 * - `RecordsSearch` and `RecordsFilterMenu` compose the upstream records-toolbar / records-filter-menu classes;
 * - tag colours come from a stable hash of the tag key into the upstream TAG_PALETTE;
 * - labels come from the caller's i18n. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import GlideMenu from "./GlideMenu";
import "./records-table.css";

function Icon({ children, size = 14, strokeWidth = 1.8 }: { children: ReactNode; size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

/* glyph library for property types */
export const RECORD_GLYPHS = {
  text: <path d="M4 6h16M4 12h10M4 18h7" />,
  single: <g><circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.4 2.4 4.6-4.9" /></g>,
  multi: <g><path d="M11 6h9M11 12h9M11 18h9" /><path d="M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17" /></g>,
  url: <g><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1" /></g>,
  date: <g><rect x="3" y="5" width="18" height="16" rx="2.5" /><path d="M8 3v4M16 3v4M3 10h18" /></g>,
  user: <g><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" /></g>,
  model: <path d="M12 3l1.7 5.1a2 2 0 0 0 1.2 1.2L20 11l-5.1 1.7a2 2 0 0 0-1.2 1.2L12 19l-1.7-5.1a2 2 0 0 0-1.2-1.2L4 11l5.1-1.7a2 2 0 0 0 1.2-1.2z" />,
  json: <g><path d="M8 4c-2 0-2 2-2 3s.5 3-2 3c2.5 0 2 2 2 3s0 3 2 3" /><path d="M16 4c2 0 2 2 2 3s-.5 3 2 3c-2.5 0-2 2-2 3s0 3-2 3" /></g>,
} as const;
export type RecordGlyph = keyof typeof RECORD_GLYPHS;

// A single mid-lightness base hue per tag. Background, text, and border are
// derived from this via color-mix() against the theme tokens in .records-tag,
// so the chips adapt to light and dark automatically (same pattern as FilterTable).
export const TAG_PALETTE = {
  amber: "oklch(0.76 0.13 70)",
  lime: "oklch(0.77 0.16 122)",
  yellow: "oklch(0.80 0.15 101)",
  purple: "oklch(0.62 0.18 293)",
  orange: "oklch(0.71 0.16 48)",
  cyan: "oklch(0.72 0.10 221)",
  red: "oklch(0.64 0.19 27)",
  magenta: "oklch(0.66 0.21 323)",
  green: "oklch(0.70 0.13 162)",
  pink: "oklch(0.67 0.19 3)",
} as const;
export type TagHue = keyof typeof TAG_PALETTE;
const HUES = Object.keys(TAG_PALETTE) as TagHue[];

/** A stable palette hue for a tag key, so the same group always reads in the same colour. */
export function tagHue(key: string): TagHue {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) hash = (hash * 31 + key.charCodeAt(index)) | 0;
  return HUES[Math.abs(hash) % HUES.length];
}

export type RecordTagValue = { key: string; label: string; hue?: TagHue | "neutral" };

export function RecordTag({ tag }: { tag: RecordTagValue }) {
  // Neutral tags tint from ink-2, not upstream's ink-3: the label is drawn from the base and needs 4.5:1.
  const base = tag.hue === "neutral" ? "var(--ink-2)" : TAG_PALETTE[tag.hue ?? tagHue(tag.key)];
  return (
    <span className="records-tag" style={{ "--tag-base": base } as React.CSSProperties}>
      {tag.label}
    </span>
  );
}

export function RecordTagList({ tags, label }: { tags: RecordTagValue[]; label: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(tags.length);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return;

    const update = () => {
      const available = container.clientWidth;
      if (!available) {
        setVisibleCount(tags.length);
        return;
      }
      const tagWidths = Array.from(measure.querySelectorAll<HTMLElement>("[data-tag-measure]"), (tag) => tag.offsetWidth);
      const moreWidth = measure.querySelector<HTMLElement>("[data-more-measure]")?.offsetWidth ?? 0;
      let used = 0;
      let count = 0;

      for (let index = 0; index < tagWidths.length; index += 1) {
        const nextUsed = used + (count > 0 ? 4 : 0) + tagWidths[index];
        const hiddenAfter = tags.length - (index + 1);
        const totalWithOverflow = nextUsed + (hiddenAfter > 0 ? 4 + moreWidth : 0);
        if (totalWithOverflow > available) break;
        used = nextUsed;
        count += 1;
      }

      setVisibleCount(count);
    };

    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [tags]);

  const hiddenCount = tags.length - visibleCount;
  const names = tags.map((tag) => tag.label).join(", ");

  return (
    <div ref={containerRef} className="records-tags" title={names} aria-label={`${label}: ${names}`}>
      <div ref={measureRef} className="records-tags-measure" aria-hidden>
        {tags.map((tag) => <span key={tag.key} data-tag-measure><RecordTag tag={tag} /></span>)}
        <span data-more-measure className="records-more-tag">+{tags.length}</span>
      </div>
      {tags.slice(0, visibleCount).map((tag) => <RecordTag key={tag.key} tag={tag} />)}
      {hiddenCount > 0 && <span className="records-more-tag">+{hiddenCount}</span>}
    </div>
  );
}

/** The upstream "connection strength" cell: a coloured dot plus a label. */
export function RecordStatus({ color, children }: { color: string; children: ReactNode }) {
  return <span className="records-strength"><span className="records-strength-dot" style={{ background: color }} />{children}</span>;
}

export type SortDir = 1 | -1;
export type RecordSort = { key: string; dir: SortDir };

export type RecordColumn<T> = {
  key: string;
  label: string;
  glyph: RecordGlyph;
  /** default width in px before the table locks its measured widths */
  width: number;
  minWidth?: number;
  sort?: (a: T, b: T) => number;
  render: (row: T) => ReactNode;
  muted?: (row: T) => boolean;
  footer?: (rows: T[]) => ReactNode;
};

export type RecordPrimary<T> = {
  label: string;
  glyph?: RecordGlyph;
  width: number;
  name: (row: T) => string;
  mark?: (row: T) => string;
  sort?: (a: T, b: T) => number;
};

export type RecordsTableLabels = {
  table: string;
  count: string;
  sortBy: (label: string) => string;
  resize: (label: string) => string;
  open: (name: string) => string;
  options: string;
  compact: string;
  reset: string;
};

function HeaderCell({ label, glyph, sorted, onSort, onResizeStart, resizing, className = "", labels }: {
  label: string;
  glyph: RecordGlyph;
  sorted: SortDir | null;
  onSort?: () => void;
  onResizeStart: (event: React.PointerEvent<HTMLSpanElement>) => void;
  resizing: boolean;
  className?: string;
  labels: RecordsTableLabels;
}) {
  return (
    <th
      scope="col"
      className={`records-header-cell ${className}`}
      aria-sort={sorted === null ? undefined : sorted === 1 ? "ascending" : "descending"}
    >
      <button
        type="button"
        className="records-header-button"
        onClick={onSort}
        disabled={!onSort}
        aria-label={onSort ? labels.sortBy(label) : undefined}
      >
        <span className="records-header-icon"><Icon size={15}>{RECORD_GLYPHS[glyph]}</Icon></span>
        <span className="truncate">{label}</span>
        {onSort && (
          <span
            aria-hidden
            className={`records-sort ${sorted !== null ? "is-visible" : ""}`}
            style={{ transform: sorted === -1 ? "rotate(180deg)" : undefined }}
          >
            <Icon size={12}><path d="M12 5v14M5 12l7 7 7-7" /></Icon>
          </span>
        )}
      </button>
      <span
        role="separator"
        aria-orientation="vertical"
        aria-label={labels.resize(label)}
        className={`records-resize-handle ${resizing ? "is-resizing" : ""}`}
        onPointerDown={onResizeStart}
      />
    </th>
  );
}

const ACTION_COLUMN = 100;

export default function RecordsTable<T>({
  rows,
  rowId,
  primary,
  columns,
  labels,
  onOpen,
  selectedId,
  initialSort,
  fill = false,
  empty,
  toolbar,
}: {
  rows: T[];
  rowId: (row: T) => string;
  primary: RecordPrimary<T>;
  columns: RecordColumn<T>[];
  labels: RecordsTableLabels;
  onOpen?: (row: T) => void;
  /** the row currently open elsewhere (an editor sheet) reads as selected */
  selectedId?: string | null;
  initialSort?: RecordSort;
  fill?: boolean;
  /** shown in place of the body when `rows` is empty */
  empty?: ReactNode;
  /** a `records-toolbar` row above the grid */
  toolbar?: ReactNode;
}) {
  const keys = useMemo(() => ["__primary", ...columns.map((column) => column.key)], [columns]);
  const defaults = useMemo(
    () => Object.fromEntries([["__primary", primary.width], ...columns.map((column) => [column.key, column.width])]) as Record<string, number>,
    [columns, primary.width],
  );
  const [sort, setSort] = useState<RecordSort>(initialSort ?? { key: "__primary", dir: 1 });
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(defaults);
  const [columnWidthsLocked, setColumnWidthsLocked] = useState(false);
  const [resizingColumn, setResizingColumn] = useState<string | null>(null);
  const initialColumnWidthsRef = useRef<Record<string, number> | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [tableMenuOpen, setTableMenuOpen] = useState<{ x: number; y: number } | null>(null);

  /* Let the table fill its available space once, then capture those rendered
   * widths before paint. From that point on every column is explicit, so a
   * resize changes only the dragged column and the table's total width. */
  useLayoutEffect(() => {
    if (columnWidthsLocked || !tableRef.current) return;
    const headers = Array.from(tableRef.current.querySelectorAll<HTMLTableCellElement>("thead th"));
    if (headers.length < keys.length + 1) return;
    const measured = Object.fromEntries(keys.map((key, index) => [key, headers[index].getBoundingClientRect().width || defaults[key]]));
    initialColumnWidthsRef.current = measured;
    setColumnWidths(measured);
    setColumnWidthsLocked(true);
  }, [columnWidthsLocked, keys, defaults]);

  const visibleRows = useMemo(() => {
    const compare = sort.key === "__primary"
      ? primary.sort ?? ((a: T, b: T) => primary.name(a).localeCompare(primary.name(b)))
      : columns.find((column) => column.key === sort.key)?.sort;
    if (!compare) return rows;
    return [...rows].sort((a, b) => compare(a, b) * sort.dir);
  }, [rows, sort, primary, columns]);

  /* click anywhere else closes the options menu */
  useEffect(() => {
    if (!tableMenuOpen) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as Element).closest("[data-recpop]")) setTableMenuOpen(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTableMenuOpen(null);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [tableMenuOpen]);

  const toggleSort = (key: string) => setSort((current) => current.key === key ? { key, dir: (current.dir * -1) as SortDir } : { key, dir: 1 });
  const startColumnResize = (key: string, minWidth = 120) => (event: React.PointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setTableMenuOpen(null);

    const startX = event.clientX;
    const startWidth = columnWidths[key];
    const previousCursor = document.body.style.cursor;
    const previousSelection = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setResizingColumn(key);

    const move = (moveEvent: PointerEvent) => {
      const width = Math.max(minWidth, startWidth + moveEvent.clientX - startX);
      setColumnWidths((current) => ({ ...current, [key]: width }));
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelection;
      setResizingColumn(null);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const tableWidth = keys.reduce((sum, key) => sum + (columnWidths[key] ?? 0), 0) + ACTION_COLUMN;
  const hasFooter = columns.some((column) => column.footer);

  return (
    <div className={`records-shell is-static-gutter${fill ? " is-fill" : ""}`}>
      {toolbar}
      <div
        className="records-scroll"
        tabIndex={0}
        role="region"
        aria-label={labels.table}
        onScroll={() => setTableMenuOpen(null)}
      >
        <table ref={tableRef} className="records-table" style={{ width: columnWidthsLocked ? tableWidth : "100%", minWidth: tableWidth }}>
          <colgroup>
            {keys.map((key) => <col key={key} style={{ width: columnWidths[key] }} />)}
            <col style={{ width: ACTION_COLUMN }} />
          </colgroup>
          <thead>
            <tr>
              <HeaderCell
                label={primary.label}
                glyph={primary.glyph ?? "text"}
                className="records-sticky-cell records-primary-header"
                sorted={sort.key === "__primary" ? sort.dir : null}
                onSort={() => toggleSort("__primary")}
                onResizeStart={startColumnResize("__primary", 180)}
                resizing={resizingColumn === "__primary"}
                labels={labels}
              />
              {columns.map((column) => (
                <HeaderCell
                  key={column.key}
                  label={column.label}
                  glyph={column.glyph}
                  sorted={sort.key === column.key ? sort.dir : null}
                  onSort={column.sort ? () => toggleSort(column.key) : undefined}
                  onResizeStart={startColumnResize(column.key, column.minWidth)}
                  resizing={resizingColumn === column.key}
                  labels={labels}
                />
              ))}
              <th className="records-header-cell">
                <div className="flex h-[35px] items-center justify-end gap-1 px-2">
                  <button
                    type="button"
                    aria-label={labels.options}
                    aria-haspopup="menu"
                    aria-expanded={!!tableMenuOpen}
                    data-recpop
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      setTableMenuOpen((current) => current ? null : {
                        x: Math.max(8, Math.min(rect.right - 220, window.innerWidth - 228)),
                        y: rect.bottom + 6,
                      });
                    }}
                    className="records-icon-button flex size-7 items-center justify-center rounded-[7px] text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
                  </button>
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, index) => {
              const id = rowId(row);
              const name = primary.name(row);
              return <tr
                key={id}
                className={`records-row ${selectedId === id ? "is-selected" : ""} ${onOpen ? "is-openable" : ""}`}
                onClick={onOpen ? (event) => {
                  if ((event.target as Element).closest("button, a, input, label")) return;
                  onOpen(row);
                } : undefined}
              >
                <th scope="row" className="records-cell records-sticky-cell records-company-cell">
                  <span className="records-rownum">{index + 1}</span>
                  <span className="records-company-mark" aria-hidden>{(primary.mark?.(row) ?? name).slice(0, 1).toUpperCase()}</span>
                  {onOpen
                    ? <button type="button" onClick={() => onOpen(row)} title={name} aria-label={labels.open(name)} className="records-company-name has-link">{name}</button>
                    : <span title={name} className="records-company-name">{name}</span>}
                </th>
                {columns.map((column) => (
                  <td key={column.key} className={`records-cell ${column.muted?.(row) ? "records-muted" : ""}`}>{column.render(row)}</td>
                ))}
                <td className="records-cell" />
              </tr>;
            })}
          </tbody>
          <tfoot>
            <tr className="records-calculation-row">
              <td className="records-cell records-sticky-cell">
                <span className="records-footer-value records-calculation-label"><span className="records-calculation-number">{rows.length}</span> {labels.count}</span>
              </td>
              {columns.map((column) => (
                <td key={column.key} className="records-cell records-muted">
                  {hasFooter && column.footer ? <span className="records-footer-value">{column.footer(rows)}</span> : null}
                </td>
              ))}
              <td className="records-cell" />
            </tr>
          </tfoot>
        </table>
        {rows.length === 0 && empty && <div className="records-empty">{empty}</div>}
      </div>

      {/* ── table options menu ─────────────────────────────── */}
      {tableMenuOpen && (
        <div
          data-recpop
          role="menu"
          aria-label={labels.options}
          className="fixed z-50 w-[220px] rounded-[14px] bg-surface p-1.5 shadow-overlay"
          style={{ top: tableMenuOpen.y, left: tableMenuOpen.x, animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "top right" }}
        >
          <div className="px-2 pb-1 pt-1 text-[12px] font-medium text-ink-2">{labels.options}</div>
          <GlideMenu className="flex flex-col gap-px">
            <button
              data-menu-row
              type="button"
              role="menuitem"
              onClick={() => {
                setColumnWidths(Object.fromEntries(keys.map((key) => [key, Math.max(key === "__primary" ? 180 : 120, Math.round((initialColumnWidthsRef.current?.[key] ?? defaults[key]) * 0.8))])));
                setTableMenuOpen(null);
              }}
              className="relative z-10 flex h-9 w-full items-center gap-2.5 rounded-[8px] px-2 text-left text-[13px] text-ink"
            >
              <span className="text-ink-2"><Icon size={15}><path d="M4 8h16M7 4 3 8l4 4M17 4l4 4-4 4M4 16h16" /></Icon></span>
              {labels.compact}
            </button>
            <button
              data-menu-row
              type="button"
              role="menuitem"
              onClick={() => {
                setColumnWidths({ ...(initialColumnWidthsRef.current ?? defaults) });
                setTableMenuOpen(null);
              }}
              className="relative z-10 flex h-9 w-full items-center gap-2.5 rounded-[8px] px-2 text-left text-[13px] text-ink"
            >
              <span className="text-ink-2"><Icon size={15}><path d="M3 12a9 9 0 1 0 3-6.7M3 4v6h6" /></Icon></span>
              {labels.reset}
            </button>
          </GlideMenu>
        </div>
      )}
    </div>
  );
}

/* ── toolbar pieces (upstream records-toolbar / records-filter-menu classes) ── */

export function RecordsToolbar({ left, right }: { left: ReactNode; right?: ReactNode }) {
  return (
    <div className="records-toolbar">
      <div className="records-toolbar-left">{left}</div>
      {right && <div className="records-toolbar-right">{right}</div>}
    </div>
  );
}

export function RecordsSearch({ value, onChange, label, placeholder }: { value: string; onChange: (value: string) => void; label: string; placeholder: string }) {
  return (
    <label className="records-select-button records-search">
      <Icon size={14}><g><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></g></Icon>
      <input
        type="search"
        value={value}
        aria-label={label}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.preventDefault();
            onChange("");
          }
        }}
      />
    </label>
  );
}

export type RecordsFilterGroup = {
  key: string;
  label: string;
  options: { value: string; label: string }[];
  /** the selected option; `null` is "any" */
  value: string | null;
  onChange: (value: string | null) => void;
  anyLabel: string;
};

export function RecordsFilterMenu({ label, groups }: { label: string; groups: RecordsFilterGroup[] }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const active = groups.some((group) => group.value !== null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="records-filter-wrap">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={`records-quiet-button ${active ? "is-active" : ""}`}
      >
        <Icon size={14}><path d="M4 6h16M7 12h10M10 18h4" /></Icon>
        {label}
        {active && <span className="records-filter-dot" aria-hidden />}
      </button>
      {open && (
        <div className="records-filter-menu" role="menu" aria-label={label}>
          {groups.map((group) => (
            <div key={group.key} role="group" aria-label={group.label}>
              <div className="records-filter-label">{group.label}</div>
              {[{ value: null as string | null, label: group.anyLabel }, ...group.options].map((option) => {
                const selected = group.value === option.value;
                return (
                  <button
                    key={option.value ?? "__any"}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className={selected ? "is-selected" : ""}
                    onClick={() => group.onChange(option.value)}
                  >
                    <span className="records-menu-check" aria-hidden>{selected ? "✓" : ""}</span>
                    {option.label}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
