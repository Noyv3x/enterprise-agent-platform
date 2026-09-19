/* Resize directly to the bounded content height. Animating textarea height
   would repeatedly reflow the conversation and move the input caret. */

import { useLayoutEffect, type RefObject } from "react";

const MAX_HEIGHT = 200;

export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    // An empty textarea must keep the CSS-defined single-line baseline. Using
    // scrollHeight here would measure a wrapped placeholder and make the blank
    // composer several lines tall on narrow screens.
    if (!value) {
      el.style.removeProperty("height");
      el.classList.remove("is-scrollable");
      return;
    }

    el.style.height = "auto";
    const fullHeight = el.scrollHeight;
    const nextHeight = Math.min(fullHeight, MAX_HEIGHT);
    el.classList.toggle("is-scrollable", fullHeight > nextHeight + 1);

    el.style.height = `${nextHeight}px`;
  }, [ref, value]);
}
