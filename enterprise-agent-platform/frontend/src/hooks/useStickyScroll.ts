/* useStickyScroll — replaces the legacy captureMessageScroll/restoreMessageScroll
   teardown dance (legacy-app.js:305-321) with a scoped useLayoutEffect.

   A passive scroll listener continuously records whether the user is within 32px
   of the bottom (the legacy `prev.bottom < 32` sticky rule). After every commit
   the layout effect snaps the container to the bottom iff:
     - forceBottom changed (the user's own send bumps a token), OR
     - scopeKey changed (switching channel/scope always jumps to bottom, the old
       `data-chat-key` behavior), OR
     - the user was already near the bottom.
   Otherwise the scroll position is left untouched. */

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

const NEAR_BOTTOM_PX = 32;

export function useStickyScroll(
  ref: RefObject<HTMLElement | null>,
  scopeKey: string,
  forceBottomToken: number,
): void {
  const nearBottom = useRef(true);
  const prevScope = useRef(scopeKey);
  const prevForce = useRef(forceBottomToken);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [ref]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scopeChanged = prevScope.current !== scopeKey;
    const forced = prevForce.current !== forceBottomToken;
    prevScope.current = scopeKey;
    prevForce.current = forceBottomToken;

    if (forced || scopeChanged || nearBottom.current) {
      el.scrollTop = el.scrollHeight;
      nearBottom.current = true;
    }
  });
}
