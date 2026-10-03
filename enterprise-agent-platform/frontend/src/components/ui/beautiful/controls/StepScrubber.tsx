/* StepScrubber — a playback position over discrete steps (upstream has no linear slider). Built from upstream atoms
 * and tokens: Switch's track (line-strong, ink when filled) and raised thumb, FineTuneCard's scrub interaction
 * (pointer capture, arrow keys). A slider: arrows step, Home/End jump, a pointer press seeks and drags. The track
 * stays 24px tall (44px on touch) for an easy target; ticks mark each step while they fit. Forced colors: the track
 * and fill keep a transparent border that the system paints. */
import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "../cn";

const MAX_TICKS = 40;

export function StepScrubber({
  count,
  value,
  onChange,
  label,
  valueText,
  disabled = false,
  className,
}: {
  /** number of steps */
  count: number;
  /** 0-based position */
  value: number;
  onChange: (index: number) => void;
  label: string;
  /** spoken position, e.g. "Step 3 of 8: Run pytest" */
  valueText: (index: number) => string;
  disabled?: boolean;
  className?: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const inactive = disabled || count < 2;
  const last = Math.max(0, count - 1);
  const at = Math.min(Math.max(value, 0), last);
  const ratio = last ? at / last : 1;

  const seek = (clientX: number) => {
    const box = track.current?.getBoundingClientRect();
    if (!box || !box.width) return;
    const next = Math.round(Math.min(1, Math.max(0, (clientX - box.left) / box.width)) * last);
    if (next !== at) onChange(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (inactive) return;
    const next = event.key === "ArrowLeft" || event.key === "ArrowDown" ? at - 1
      : event.key === "ArrowRight" || event.key === "ArrowUp" ? at + 1
        : event.key === "Home" ? 0
          : event.key === "End" ? last
            : null;
    if (next === null) return;
    event.preventDefault();
    const clamped = Math.min(last, Math.max(0, next));
    if (clamped !== at) onChange(clamped);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (inactive || event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragging.current = true;
    seek(event.clientX);
  };

  return (
    <div
      role="slider"
      aria-label={label}
      aria-valuemin={count ? 1 : 0}
      aria-valuemax={count}
      aria-valuenow={count ? at + 1 : 0}
      aria-valuetext={count ? valueText(at) : undefined}
      aria-disabled={inactive || undefined}
      tabIndex={inactive ? -1 : 0}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={(event) => {
        if (dragging.current) seek(event.clientX);
      }}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
      className={cn(
        "group/scrub relative flex h-6 min-w-0 touch-none items-center rounded-full px-1.5 select-none touch:h-11",
        inactive ? "opacity-50" : "cursor-pointer",
        className,
      )}
    >
      <div ref={track} className="relative h-1 w-full rounded-full border border-transparent bg-line-strong">
        <span
          aria-hidden
          className="absolute inset-y-[-1px] left-[-1px] rounded-full border border-transparent bg-ink"
          style={{ width: `calc(${ratio * 100}% + 2px)` }}
        />
        {count > 1 && count <= MAX_TICKS && Array.from({ length: count }, (_, index) => (
          <span
            key={index}
            aria-hidden
            className={cn("absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full", index <= at ? "bg-surface/70" : "bg-ink-3")}
            style={{ left: `${(index / last) * 100}%` }}
          />
        ))}
        <span
          aria-hidden
          className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-surface shadow-btn transition-transform duration-150 group-active/scrub:scale-110"
          style={{ left: `${ratio * 100}%`, transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)" }}
        />
      </div>
    </div>
  );
}
