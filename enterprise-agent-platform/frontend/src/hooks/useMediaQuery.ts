/* useMediaQuery — subscribe to a CSS media query via matchMedia + a change
   listener. Used for the 800px mobile-drawer breakpoint (legacy mobileQuery,
   legacy-app.js:3497-3500). Implemented over useSyncExternalStore so the value
   never tears. */

import { useCallback, useSyncExternalStore } from "react";

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);

  // No SSR in this app, but provide a stable server snapshot for correctness.
  const getServerSnapshot = () => false;

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
