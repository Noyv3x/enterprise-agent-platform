/* Adapted from Beautiful UI components/primitives/AgentScreen.tsx (MIT, see ../NOTICE).
 * Adaptations:
 * - window mode: the resting card is upstream's FauxWindow (exported below) carrying real data instead of the
 *   placeholder capture: traffic lights, the caller's title tab(s), an address row only when the caller gives one,
 *   and the caller's content. It fills the height its parent gives it (the caller fixes that height so the window
 *   never jumps), is a real window rather than a clickable card (its content scrolls; there is no hover overlay),
 *   and upstream's open icon sits at the right of the title row to open the expanded viewer;
 * - the content is the agent browser's live screenshot (`streamSrc`, fitted to the window's width and top-aligned,
 *   since the window is taller than a page) or a caller node (`screen`); the expanded viewer shows the screenshot as
 *   upstream does, or the caller's larger node (`viewerScreen`) inside the same window chrome; without either the
 *   window shows the caller's empty message;
 * - "Teach a task" / recording becomes human takeover: the caller's controls acquire and release the browser
 *   lease, and the REC badge becomes the control badge with the time held (in the title row and the viewer);
 * - the viewer is controlled (`open`), forwards clicks on the screen while the person holds control, and
 *   renders the caller's input row below the screen; the custom cursor shows only while interactive;
 * - labels come from the caller (i18n); the dialog traps focus, restores it, and consumes Escape before a parent sheet;
 * - the expanded viewer sits above sheets (60) and below its portaled popovers (80);
 * - the expanded viewer's frame (scrim, card, title bar with name, status, controls and collapse, screen inset and
 *   input row) is exported as `ScreenViewer`, which the personal AI's process output viewer also uses.
 * Markup, classes, radii and motion are upstream's. */
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../cn";
import "./agentScreen.css";

/* ─────────────────────────────────────────────────────────
 * AGENT SCREEN (live viewer)
 * Watch an agent work. The window shows what the agent is doing;
 * its open control expands a full-width viewer where you can take
 * control, collapse (control keeps running, the window shows a red
 * badge), and hand back.
 * ───────────────────────────────────────────────────────── */

const SCREEN_ASPECT = "aspect-[16/10]";

export function Ico({ path, size = 15, sw = 2 }: { path: ReactNode; size?: number; sw?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {path}
    </svg>
  );
}

/* minimize-2 — two arrows converging to the middle (collapse) */
const collapseIcon = (
  <>
    <polyline points="4 14 10 14 10 20" />
    <polyline points="20 10 14 10 14 4" />
    <line x1="14" y1="10" x2="21" y2="3" />
    <line x1="3" y1="21" x2="10" y2="14" />
  </>
);

/* maximize-2 — two arrows out to opposite corners (open) */
const openIcon = (
  <>
    <polyline points="15 3 21 3 21 9" />
    <polyline points="9 21 3 21 3 15" />
    <line x1="21" y1="3" x2="14" y2="10" />
    <line x1="3" y1="21" x2="10" y2="14" />
  </>
);

/** take-control glyph: a target ring, as upstream's "Teach a task" */
export const controlIcon = <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" /></>;

export function fmt(total: number) {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/* macOS-style pointer */
function CursorSvg({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg className={className} style={style} width="30" height="30" viewBox="0 0 24 24" fill="#111318" stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" aria-hidden>
      <path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z" />
    </svg>
  );
}

/* connecting state — spinner on black, same ring as Task Rows */
function LoadingScreen({ label }: { label: string }) {
  const size = 26,
    stroke = 2,
    r = (size - stroke) / 2,
    c = 2 * Math.PI * r;
  return (
    <div className="absolute inset-0 bg-black">
      <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <svg width={size} height={size} className="block" style={{ animation: "spin 1.1s linear infinite" }} aria-hidden>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth={stroke} />
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#fff" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${c * 0.28} ${c * 0.72}`} />
        </svg>
      </span>
      <span
        className="absolute inset-x-0 text-center text-[12.5px] font-medium text-white/70"
        style={{ top: "calc(50% + 28px)" }}
      >
        {label}
      </span>
    </div>
  );
}

export type WindowTab = { id: string; label: string };

const TAB = "flex min-w-0 items-center gap-1.5 rounded-t-[6px] px-2 py-1 text-[11.5px] font-medium leading-none";
const ACTIVE_TAB = "bg-surface text-ink shadow-[0_-1px_0_var(--line)] forced-colors:border forced-colors:border-b-0";

/** Upstream's FauxWindow with real data: traffic lights and title tab(s) on an inset bar, an optional address row
 * (decorative back/forward and a URL pill), then the content. Accessibility adaptations: the tab and URL text are
 * real labels in ink / ink-2 at 11.5px (upstream draws placeholder bars and 9px ink-3); several tabs become
 * buttons choosing the shown one when the caller handles `onTabChange`; the tab and pill get a border under forced
 * colors. */
export function FauxWindow({ tabs, activeTab, onTabChange, tabsLabel, address, actions, children }: {
  tabs: WindowTab[];
  activeTab?: string;
  onTabChange?: (id: string) => void;
  /** accessible name of the tab group when tabs are choosable */
  tabsLabel?: string;
  /** shown in the address row; the row is omitted without one */
  address?: string | null;
  /** controls at the right of the title row */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const active = activeTab ?? tabs[0]?.id;
  const choosable = Boolean(onTabChange) && tabs.length > 1;
  return (
    <div className="flex h-full w-full flex-col bg-surface">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line bg-inset px-2.5 py-1.5">
        <span aria-hidden className="flex shrink-0 items-center gap-1">
          <span className="size-2 rounded-full bg-red" />
          <span className="size-2 rounded-full bg-orange" />
          <span className="size-2 rounded-full bg-green" />
        </span>
        <div role={choosable ? "group" : undefined} aria-label={choosable ? tabsLabel : undefined} className="ml-1 flex min-w-0 flex-1 items-center gap-0.5">
          {tabs.map((tab) => {
            const selected = tab.id === active;
            const marker = <span aria-hidden className="size-2 shrink-0 rounded-[3px] bg-accent-tint" />;
            return choosable ? (
              <button
                key={tab.id}
                type="button"
                aria-pressed={selected}
                title={tab.label}
                onClick={() => onTabChange?.(tab.id)}
                className={cn(TAB, "max-w-[12rem] transition-colors duration-100 touch:min-h-11", selected ? ACTIVE_TAB : "text-ink-2 hover:bg-hover hover:text-ink")}
              >
                {marker}
                <span className="truncate">{tab.label}</span>
              </button>
            ) : (
              <span key={tab.id} title={tab.label} className={cn(TAB, selected ? ACTIVE_TAB : "text-ink-2")}>
                {marker}
                <span className="truncate">{tab.label}</span>
              </span>
            );
          })}
        </div>
        {actions && <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      {address && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-2.5 py-1.5 text-ink-3">
          <Ico size={12} path={<path d="M15 18l-6-6 6-6" />} />
          <Ico size={12} path={<path d="M9 6l6 6-6 6" />} />
          <span className="min-w-0 flex-1 truncate rounded-full bg-field px-2.5 py-[3px] font-mono text-[11.5px] text-ink-2 forced-colors:border" title={address}>
            {address}
          </span>
        </div>
      )}
      <div className="relative min-h-0 flex-1">{children}</div>
    </div>
  );
}

/** The expanded viewer's frame, portaled to <body> so it takes over the whole page: traps focus while mounted,
 * restores it on unmount, and consumes Escape before a parent sheet. Mount it only while open. `focusClose` moves
 * focus to the collapse control instead of the first control (when that one is a destructive action). */
export function ScreenViewer({ title, status, controls, collapseLabel, onClose, inputs, screenClassName, onScreenMouseMove, onScreenMouseLeave, focusClose = false, children }: {
  /** the dialog's name, shown at the far left of the title bar */
  title: string;
  status?: ReactNode;
  controls?: ReactNode;
  collapseLabel: string;
  onClose: () => void;
  /** row below the screen */
  inputs?: ReactNode;
  screenClassName?: string;
  onScreenMouseMove?: (event: MouseEvent<HTMLDivElement>) => void;
  onScreenMouseLeave?: () => void;
  focusClose?: boolean;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Lock scroll and contain focus while the viewer is open.
  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    (focusClose ? dialog?.querySelector<HTMLElement>("[data-viewer-close]") : dialog?.querySelector<HTMLElement>("button, input, [tabindex]"))?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input, select, [tabindex]:not([tabindex='-1'])"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      returnFocus?.focus();
    };
  }, []);

  return createPortal(
    <div
      ref={dialogRef}
      className="fixed inset-0 z-[70] flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <div
        className="absolute inset-0 bg-black/60 dark:bg-black/75"
        style={{ animation: "fade-in 180ms ease-out both" }}
        onClick={onClose}
      />
      <div
        className="relative flex max-h-full max-w-full flex-col overflow-hidden rounded-[16px] bg-surface p-2 pt-0 shadow-overlay"
        style={{ animation: "pop-in 240ms cubic-bezier(0.23,1,0.32,1) both" }}
      >
        {/* title bar — agent name far left, controls right */}
        <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1.5 py-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-ink">{title}</span>
            {status}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {controls}
            <button
              type="button"
              data-viewer-close
              aria-label={collapseLabel}
              onClick={onClose}
              className="primitive-icon-button text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink pointer-coarse:size-11"
            >
              <Ico size={15} path={collapseIcon} />
            </button>
          </div>
        </div>

        {/* the screen — inset with a little padding; the image sizes the window so the whole screen fits */}
        <div
          className={cn("relative min-h-0 overflow-hidden rounded-[8px] bg-inset", screenClassName)}
          onMouseMove={onScreenMouseMove}
          onMouseLeave={onScreenMouseLeave}
        >
          {children}
        </div>
        {inputs && <div className="shrink-0 pt-2">{inputs}</div>}
      </div>
    </div>,
    document.body,
  );
}

export type AgentScreenLabels = {
  open: string;
  collapse: string;
  connecting: string;
  /** accessible name of the screen image */
  screen: string;
  /** accessible name of the window's tabs when they are choosable */
  tabs?: string;
  /** accessible name of the window (a region) */
  window: string;
};

export default function AgentScreen({
  agentName,
  status,
  tabs,
  activeTab,
  onTabChange,
  address,
  streamSrc,
  screen,
  viewerScreen,
  loading = false,
  empty,
  open,
  onOpenChange,
  controlling = false,
  controlSince,
  controls,
  inputs,
  onScreenClick,
  onFrameLoad,
  onFrameError,
  labels,
  className,
}: {
  agentName: string;
  /** status shown next to the name (e.g. a Working pill) */
  status?: ReactNode;
  /** the window's title tab(s) */
  tabs: WindowTab[];
  activeTab?: string;
  /** makes several tabs choosable */
  onTabChange?: (id: string) => void;
  /** the window's address row (a URL or query); omitted when absent */
  address?: string | null;
  /** current screenshot URL; absent → `empty` */
  streamSrc?: string | null;
  /** a node shown in the window instead of the screenshot */
  screen?: ReactNode;
  /** a node shown in the expanded viewer instead of the screenshot, in a fixed-size frame */
  viewerScreen?: ReactNode;
  loading?: boolean;
  /** shown in the window when there is no screen */
  empty?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** the person holds control: badge in the window and in the viewer, screen clicks forward */
  controlling?: boolean;
  /** epoch ms control was taken, for the badge timer */
  controlSince?: number | null;
  /** viewer title-bar controls (take control / hand back) */
  controls?: ReactNode;
  /** viewer row below the screen (playback, address, typing) */
  inputs?: ReactNode;
  onScreenClick?: (event: MouseEvent<HTMLImageElement>) => void;
  onFrameLoad?: () => void;
  onFrameError?: () => void;
  labels: AgentScreenLabels;
  /** the root's layout (its height bounds the window) */
  className?: string;
}) {
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // tick while controlling — survives collapse (state lives in the caller, not the overlay)
  useEffect(() => {
    if (!controlling) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [controlling]);
  const secs = controlling && controlSince ? Math.max(0, Math.floor((now - controlSince) / 1000)) : 0;

  const badge = controlling && (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-red-tint py-0.5 pl-1.5 pr-2 text-[11.5px] font-medium tabular-nums text-red">
      <span className="size-2 rounded-full bg-red" style={{ animation: "records-pulse 1.1s ease-in-out infinite" }} />
      {fmt(secs)}
    </span>
  );

  return (
    <div className={cn("flex w-full min-w-0 flex-col", className)}>
      {/* ── the window ── */}
      <section
        aria-label={labels.window}
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-window bg-surface shadow-card"
        style={{ animation: "fade-up 380ms cubic-bezier(0.23,1,0.32,1) both" }}
      >
        <FauxWindow
          tabs={tabs}
          activeTab={activeTab}
          onTabChange={onTabChange}
          tabsLabel={labels.tabs}
          address={address}
          actions={
            <>
              {badge}
              <button
                type="button"
                aria-label={labels.open}
                title={labels.open}
                disabled={loading}
                onClick={() => onOpenChange(true)}
                className="primitive-icon-button size-6 text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink disabled:opacity-50 touch:size-11"
              >
                <Ico size={13} path={openIcon} />
              </button>
            </>
          }
        >
          {loading ? (
            <LoadingScreen label={labels.connecting} />
          ) : screen ? (
            screen
          ) : streamSrc ? (
            <img
              src={streamSrc}
              alt={labels.screen}
              className="absolute inset-0 h-full w-full bg-inset object-contain object-top"
              onLoad={open ? undefined : onFrameLoad}
              onError={open ? undefined : onFrameError}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-inset p-4 text-center text-[12.5px] text-ink-2">{empty}</div>
          )}
        </FauxWindow>
      </section>

      <div className="mt-2.5 flex min-w-0 items-center gap-2 px-0.5">
        <span className="truncate text-[13px] font-medium text-ink" title={agentName}>{agentName}</span>
        {status}
      </div>

      {/* ── expanded viewer — portaled to <body> so it takes over the whole page ── */}
      {open && (
        <ScreenViewer
          title={agentName}
          status={controlling ? badge : status}
          controls={controls}
          collapseLabel={labels.collapse}
          onClose={() => onOpenChange(false)}
          inputs={inputs}
          screenClassName={controlling ? "[cursor:none]" : undefined}
          onScreenMouseMove={(e) => {
            if (!controlling) return;
            const r = e.currentTarget.getBoundingClientRect();
            setCursorPos({ x: e.clientX - r.left, y: e.clientY - r.top });
          }}
          onScreenMouseLeave={() => setCursorPos(null)}
        >
          {viewerScreen ? (
            <div className="relative overflow-hidden" style={{ width: "min(960px, 90vw)", height: inputs ? "min(560px, calc(100vh - 230px))" : "min(560px, calc(100vh - 150px))" }}>
              <FauxWindow tabs={tabs} activeTab={activeTab} address={address}>{viewerScreen}</FauxWindow>
            </div>
          ) : loading || !streamSrc ? (
            <div className={`relative ${SCREEN_ASPECT}`} style={{ width: "min(960px, 90vw)" }}>
              {loading ? <LoadingScreen label={labels.connecting} /> : (
                <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-[13px] text-ink-2">{empty}</div>
              )}
            </div>
          ) : (
            <img
              src={streamSrc}
              alt={labels.screen}
              className="block h-auto w-auto object-contain"
              style={{ maxHeight: inputs ? "calc(100vh - 230px)" : "calc(100vh - 150px)", maxWidth: "min(960px, 90vw)" }}
              onClick={controlling ? onScreenClick : undefined}
              onLoad={onFrameLoad}
              onError={onFrameError}
            />
          )}
          {controlling && cursorPos && (
            <CursorSvg
              className="pointer-events-none absolute z-10"
              style={{ left: cursorPos.x, top: cursorPos.y, filter: "drop-shadow(0 1px 1.5px rgba(0,0,0,0.35))" }}
            />
          )}
        </ScreenViewer>
      )}
    </div>
  );
}
