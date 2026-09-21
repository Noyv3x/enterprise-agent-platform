import { useCallback, useLayoutEffect, useRef } from "react";

/** Restore after the real panel detaches, unless another live control took focus. */
export function useUnmountFocusRestore(open: boolean) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const openRef = useRef(open);

  useLayoutEffect(() => {
    openRef.current = open;
    const focused = document.activeElement;
    if (open && focused instanceof HTMLElement && focused !== document.body && !panelRef.current?.contains(focused)) {
      openerRef.current = focused;
    }
  }, [open]);

  return useCallback((panel: HTMLDivElement | null) => {
    if (panel) {
      panelRef.current = panel;
      const focused = document.activeElement;
      if (openRef.current && focused instanceof HTMLElement && focused !== document.body && !panel.contains(focused)) {
        openerRef.current = focused;
      }
      return;
    }
    const removedPanel = panelRef.current;
    const opener = openerRef.current;
    queueMicrotask(() => {
      // StrictMode ref replay keeps the panel connected. A newly focused field
      // wins over restoration, including autofocus during the same commit.
      if (!removedPanel || removedPanel.isConnected || !opener?.isConnected) return;
      const focused = document.activeElement;
      if (focused === document.body || !focused?.isConnected || removedPanel.contains(focused)) {
        opener.focus({ preventScroll: true });
      }
    });
  }, []);
}
