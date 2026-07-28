/* useAutoGrow resizes the textarea to its content in a layout effect keyed on
   its value, capped at 200px. It toggles the .is-scrollable class past the cap and
   uses the previous-height reflow trick so the height change animates. The
   first run on mount does not animate. */

import { useLayoutEffect, useRef, type RefObject } from "react";

const MAX_HEIGHT = 200;

export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
): void {
  const mounted = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const animate = mounted.current;
    mounted.current = true;

    const previousHeight = el.getBoundingClientRect().height;
    el.style.height = "auto";
    const fullHeight = el.scrollHeight;
    const nextHeight = Math.min(fullHeight, MAX_HEIGHT);
    el.classList.toggle("is-scrollable", fullHeight > nextHeight + 1);

    if (!animate || !previousHeight || Math.abs(previousHeight - nextHeight) < 1) {
      el.style.height = `${nextHeight}px`;
      return;
    }

    // Set the old height, force a reflow, then the new height so the CSS height
    // transition has two distinct frames to animate between.
    el.style.height = `${previousHeight}px`;
    void el.offsetHeight;
    el.style.height = `${nextHeight}px`;
  }, [ref, value]);
}
