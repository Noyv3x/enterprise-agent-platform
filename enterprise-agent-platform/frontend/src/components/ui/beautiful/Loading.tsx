/* Beautiful UI primitives/LoadingState.tsx + atoms/Shimmer.tsx (MIT, see ./LICENSE), adapted:
 * the label and elapsed time come from the caller (real run state), there is no demo timer or video,
 * and reduced motion shows a still grid and plain label text. */
import type { ReactNode } from "react";
import { cn } from "./cn";

const chevron = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3), c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});

const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const orbit = Array.from({ length: 9 }, (_, i) => {
  const k = ORBIT_ORDER.indexOf(i);
  return k === -1 ? null : k * 110;
});

const PATTERNS = {
  drive: { delays: chevron, dur: 650, round: false },
  dots: { delays: chevron, dur: 650, round: true },
  orbit: { delays: orbit, dur: 950, round: false },
} as const;

export type LoaderVariant = keyof typeof PATTERNS;

/** The 3×3 pixel-grid loader. Decorative: pair it with a text status. */
export function LoaderGrid({ variant = "drive", className }: { variant?: LoaderVariant; className?: string }) {
  const { delays, dur, round } = PATTERNS[variant];
  return (
    <span aria-hidden className={cn("grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]", className)}>
      {delays.map((delay, index) => (
        <span
          key={index}
          className={`size-[4px] bg-ink ${round ? "rounded-full" : "rounded-[1px]"}`}
          style={{
            opacity: delay === null ? 0.07 : 0.15,
            animation: delay === null ? "none" : `pixel-on ${dur}ms ease-in-out ${delay}ms infinite`,
          }}
        />
      ))}
    </span>
  );
}

/** Shimmering label — signals the agent is processing. `bui-shimmer` lets reduced motion fall back to plain text. */
export function Shimmer({ children, className, speed = "1.4s" }: { children: ReactNode; className?: string; speed?: string }) {
  return (
    <span
      className={cn("bui-shimmer inline-block bg-clip-text text-transparent", className)}
      style={{
        backgroundImage: "linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)",
        backgroundSize: "200% 100%",
        animation: `shimmer-text ${speed} linear infinite`,
      }}
    >
      {children}
    </span>
  );
}

/** Loader grid + shimmering label + elapsed time in mono tabular figures. */
export function LoadingState({
  label,
  elapsed,
  variant = "drive",
  className,
}: {
  label: ReactNode;
  /** already formatted, e.g. "12s"; announced by the caller if needed */
  elapsed?: ReactNode;
  variant?: LoaderVariant;
  className?: string;
}) {
  return (
    <div className={cn("flex w-fit max-w-full items-center gap-2.5", className)}>
      <LoaderGrid variant={variant} />
      <Shimmer className="min-w-0 truncate text-[13px] font-medium">{label}</Shimmer>
      {elapsed != null && elapsed !== "" && <span className="shrink-0 font-mono text-[12px] text-ink-3 tabular-nums">{elapsed}</span>}
    </div>
  );
}
