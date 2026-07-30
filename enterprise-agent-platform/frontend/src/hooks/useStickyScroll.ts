/* Sticky chat scrolling with an explicit unread affordance. A user who has
 * scrolled away from the latest message keeps their position; incoming items are
 * counted until they return to the bottom. Scope changes and the user's own send
 * still snap to the latest message. */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

export const NEAR_BOTTOM_PX = 48;

export interface StickyScrollState {
  atBottom: boolean;
  unreadCount: number;
  scrollToBottom: () => void;
}

export function distanceFromBottom(
  element: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
): number {
  return Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight);
}

export function isNearBottom(
  element: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
): boolean {
  return distanceFromBottom(element) <= NEAR_BOTTOM_PX;
}

export function useStickyScroll(
  ref: RefObject<HTMLElement | null>,
  scopeKey: string,
  forceBottomToken: number,
  itemCount: number,
  contentRevision: number = itemCount,
  prependVersion: number = 0,
): StickyScrollState {
  const nearBottom = useRef(true);
  const prevScope = useRef(scopeKey);
  const prevForce = useRef(forceBottomToken);
  const prevItemCount = useRef(itemCount);
  const prevPrependVersion = useRef(prependVersion);
  const previousGeometry = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);

  const settleAtBottom = useCallback(() => {
    nearBottom.current = true;
    setAtBottom(true);
    setUnreadCount(0);
  }, []);

  const scrollToBottom = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const reduceMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof element.scrollTo === "function") {
      element.scrollTo({ top: element.scrollHeight, behavior: reduceMotion ? "auto" : "smooth" });
    } else {
      element.scrollTop = element.scrollHeight;
    }
    settleAtBottom();
  }, [ref, settleAtBottom]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const onScroll = () => {
      const nextAtBottom = isNearBottom(element);
      nearBottom.current = nextAtBottom;
      previousGeometry.current = {
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
      };
      setAtBottom((current) => (current === nextAtBottom ? current : nextAtBottom));
      if (nextAtBottom) setUnreadCount((current) => (current ? 0 : current));
    };
    onScroll();
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [ref, scopeKey]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const scopeChanged = prevScope.current !== scopeKey;
    const forced = prevForce.current !== forceBottomToken;
    const prepended = prevPrependVersion.current !== prependVersion;
    const addedItems = Math.max(0, itemCount - prevItemCount.current);
    const geometry = previousGeometry.current;
    prevScope.current = scopeKey;
    prevForce.current = forceBottomToken;
    prevItemCount.current = itemCount;
    prevPrependVersion.current = prependVersion;

    if (prepended && geometry && !scopeChanged && !forced) {
      const addedHeight = Math.max(0, element.scrollHeight - geometry.scrollHeight);
      element.scrollTop = geometry.scrollTop + addedHeight;
      const nextAtBottom = isNearBottom(element);
      nearBottom.current = nextAtBottom;
      setAtBottom(nextAtBottom);
      // Loading earlier rows is not a new-message event; preserve unreadCount.
    } else if (forced || scopeChanged || nearBottom.current) {
      element.scrollTop = element.scrollHeight;
      settleAtBottom();
    } else if (addedItems > 0) {
      setUnreadCount((current) => current + addedItems);
    }
    previousGeometry.current = {
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    };
  }, [contentRevision, forceBottomToken, itemCount, prependVersion, ref, scopeKey, settleAtBottom]);

  return { atBottom, unreadCount, scrollToBottom };
}
