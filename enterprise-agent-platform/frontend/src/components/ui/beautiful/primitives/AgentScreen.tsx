/* Adapted from Beautiful UI components/primitives/AgentScreen.tsx (MIT, see ../NOTICE).
 * Adaptations:
 * - the screen is the agent browser's live screenshot from the caller (`streamSrc`), not the placeholder capture;
 *   without one the card shows the caller's empty message; the faux window is removed;
 * - "Teach a task" / recording becomes human takeover: the caller's controls acquire and release the browser
 *   lease, and the REC badge becomes the control badge with the time held;
 * - the viewer is controlled (`open`), forwards clicks on the screen while the person holds control, and
 *   renders the caller's input row below the screen; the custom cursor shows only while interactive;
 * - labels come from the caller (i18n); the dialog traps focus, restores it, and consumes Escape before a parent sheet;
 * - the expanded viewer sits above sheets (60) and below its portaled popovers (80).
 * Markup, classes, radii and motion are upstream's. */
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "../atoms/Button";
import "./agentScreen.css";

/* ─────────────────────────────────────────────────────────
 * AGENT SCREEN (live viewer)
 * Watch an agent work. The resting card is a framed capture of
 * the agent's screen; hover reveals an "Open" pill (the blue
 * accent Button). Open expands to a full-width viewer where you
 * can take control, collapse (control keeps running, the card
 * shows a red badge), and hand back.
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

export type AgentScreenLabels = {
  open: string;
  collapse: string;
  connecting: string;
  /** accessible name of the screen image */
  screen: string;
};

export default function AgentScreen({
  agentName,
  status,
  streamSrc,
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
}: {
  agentName: string;
  /** status shown next to the name (e.g. a Working pill) */
  status?: ReactNode;
  /** current screenshot URL; absent → `empty` */
  streamSrc?: string | null;
  loading?: boolean;
  /** shown on the card when there is no screen */
  empty?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** the person holds control: badge on the card and in the viewer, screen clicks forward */
  controlling?: boolean;
  /** epoch ms control was taken, for the badge timer */
  controlSince?: number | null;
  /** viewer title-bar controls (take control / hand back) */
  controls?: ReactNode;
  /** viewer row below the screen (address, typing) */
  inputs?: ReactNode;
  onScreenClick?: (event: MouseEvent<HTMLImageElement>) => void;
  onFrameLoad?: () => void;
  onFrameError?: () => void;
  labels: AgentScreenLabels;
}) {
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  // tick while controlling — survives collapse (state lives in the caller, not the overlay)
  useEffect(() => {
    if (!controlling) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [controlling]);
  const secs = controlling && controlSince ? Math.max(0, Math.floor((now - controlSince) / 1000)) : 0;

  // Lock scroll and contain focus while the viewer is open.
  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLElement>("button, input, [tabindex]")?.focus();
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
      returnFocus.current?.focus();
    };
  }, [open, onOpenChange]);

  const badge = controlling && (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-red-tint py-0.5 pl-1.5 pr-2 text-[11.5px] font-medium tabular-nums text-red">
      <span className="size-2 rounded-full bg-red" style={{ animation: "records-pulse 1.1s ease-in-out infinite" }} />
      {fmt(secs)}
    </span>
  );

  return (
    <div className="w-full">
      {/* ── resting card ── */}
      <div
        className={`group/screen relative ${SCREEN_ASPECT} overflow-hidden rounded-window bg-inset shadow-card transition-shadow duration-150 ${
          loading ? "" : "cursor-pointer hover:shadow-raised"
        }`}
        onClick={loading ? undefined : () => onOpenChange(true)}
        style={{ animation: "fade-up 380ms cubic-bezier(0.23,1,0.32,1) both" }}
      >
        {loading ? (
          <LoadingScreen label={labels.connecting} />
        ) : (
          <>
            <div className="absolute inset-0 overflow-hidden bg-inset">
              {streamSrc ? (
                <img
                  src={streamSrc}
                  alt={labels.screen}
                  className="absolute inset-0 h-full w-full object-cover object-top"
                  onLoad={open ? undefined : onFrameLoad}
                  onError={open ? undefined : onFrameError}
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-[12.5px] text-ink-2">{empty}</div>
              )}
            </div>
            {controlling && <span className="absolute top-2 left-2">{badge}</span>}

            {/* hover reveal — scoped to this frame's named group */}
            <div className="absolute inset-0 flex items-center justify-center bg-[rgba(17,19,24,0)] transition-colors duration-150 group-hover/screen:bg-[rgba(17,19,24,0.18)] group-focus-within/screen:bg-[rgba(17,19,24,0.18)]">
              <span className="translate-y-1 opacity-0 transition duration-150 group-hover/screen:translate-y-0 group-hover/screen:opacity-100 group-focus-within/screen:translate-y-0 group-focus-within/screen:opacity-100 pointer-coarse:translate-y-0 pointer-coarse:opacity-100">
                <Button
                  variant="accent"
                  size="sm"
                  className="pointer-coarse:h-11"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenChange(true);
                  }}
                >
                  <Ico size={14} path={openIcon} />
                  {labels.open}
                </Button>
              </span>
            </div>
          </>
        )}
      </div>

      <div className="mt-2.5 flex min-w-0 items-center gap-2 px-0.5">
        <span className="truncate text-[13px] font-medium text-ink">{agentName}</span>
        {status}
      </div>

      {/* ── expanded viewer — portaled to <body> so it takes over the whole page ── */}
      {open &&
        createPortal(
          <div
            ref={dialogRef}
            className="fixed inset-0 z-[70] flex items-center justify-center p-4 sm:p-6"
            role="dialog"
            aria-modal="true"
            aria-label={agentName}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              onOpenChange(false);
            }}
          >
            <div
              className="absolute inset-0 bg-black/60 dark:bg-black/75"
              style={{ animation: "fade-in 180ms ease-out both" }}
              onClick={() => onOpenChange(false)}
            />
            <div
              className="relative flex max-h-full max-w-full flex-col overflow-hidden rounded-[16px] bg-surface p-2 pt-0 shadow-overlay"
              style={{ animation: "pop-in 240ms cubic-bezier(0.23,1,0.32,1) both" }}
            >
              {/* title bar — agent name far left, controls right */}
              <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1.5 py-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[13px] font-semibold text-ink">{agentName}</span>
                  {controlling ? badge : status}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {controls}
                  <button
                    type="button"
                    aria-label={labels.collapse}
                    onClick={() => onOpenChange(false)}
                    className="primitive-icon-button text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink pointer-coarse:size-11"
                  >
                    <Ico size={15} path={collapseIcon} />
                  </button>
                </div>
              </div>

              {/* the screen — inset with a little padding; the image sizes the window so the whole screen fits */}
              <div
                className={`relative min-h-0 overflow-hidden rounded-[8px] bg-inset ${controlling ? "[cursor:none]" : ""}`}
                onMouseMove={(e) => {
                  if (!controlling) return;
                  const r = e.currentTarget.getBoundingClientRect();
                  setCursorPos({ x: e.clientX - r.left, y: e.clientY - r.top });
                }}
                onMouseLeave={() => setCursorPos(null)}
              >
                {loading || !streamSrc ? (
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
                    style={{ maxHeight: inputs ? "calc(100vh - 210px)" : "calc(100vh - 150px)", maxWidth: "min(960px, 90vw)" }}
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
              </div>
              {inputs && <div className="shrink-0 pt-2">{inputs}</div>}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
