import { useLayoutEffect, useRef } from "react";

/** Ant owns normal close focus; conditional unmount skips its after-close phase. */
export function useUnmountFocusRestore(open: boolean) {
  const contentRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const openRef = useRef(open);

  useLayoutEffect(() => {
    openRef.current = open;
    const focused = document.activeElement;
    const panel = contentRef.current?.closest('[role="dialog"]');
    if (open && focused instanceof HTMLElement && !panel?.contains(focused)) {
      openerRef.current = focused;
    }
  }, [open]);

  useLayoutEffect(() => () => {
    if (!openRef.current) return;
    const panel = contentRef.current?.closest('[role="dialog"]');
    const opener = openerRef.current;
    queueMicrotask(() => {
      // StrictMode cleanup or a live focus owner must not move focus.
      if (!panel || panel.isConnected || !opener?.isConnected) return;
      const focused = document.activeElement;
      if (focused === document.body || (focused && !focused.isConnected && panel.contains(focused))) {
        opener.focus({ preventScroll: true });
      }
    });
  }, []);

  return contentRef;
}
