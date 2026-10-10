/** Shared timing for conversation rows that move or leave (foundation ease-out-strong, under 300 ms). */
export const EASE_OUT_STRONG = "cubic-bezier(0.23,1,0.32,1)";
export const GLIDE_MS = 260;
export const LEAVE_MS = 240;

/** Reduced motion turns moves and collapses into instant changes. */
export function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
