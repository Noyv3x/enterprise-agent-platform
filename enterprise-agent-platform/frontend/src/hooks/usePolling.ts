/* usePolling — the safety-net poll behind the SSE stream (legacy startPolling/
   stopPolling, legacy-app.js:3285-3302). The caller selects a fast reconnect
   interval or a low-frequency connected watchdog. It is gated on an
   authenticated user and tab visibility; the re-entrancy mutex lives inside
   refreshActiveChat. Hidden tabs clear the interval; becoming visible does an
   immediate catch-up refresh and restarts it. The interval is also torn down on
   logout/401 via the session teardown registry. */

import { useEffect } from "react";
import { registerSessionTeardown } from "../data/sessionActions";
import { refreshActiveChat } from "../data/chatActions";
import { useStore, useStoreHandle } from "../store/useStore";

const DEFAULT_POLL_INTERVAL_MS = 4_000;

export function usePolling(intervalMs = DEFAULT_POLL_INTERVAL_MS): void {
  const store = useStoreHandle();
  const userId = useStore((state) => state.user?.id);
  const interval = Math.max(1_000, Math.min(60_000, Math.round(intervalMs)));

  useEffect(() => {
    if (!userId) return;

    let timer: number | null = null;

    const stop = () => {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const start = () => {
      if (timer == null) timer = window.setInterval(() => void refreshActiveChat(store), interval);
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        void refreshActiveChat(store);
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    const unregister = registerSessionTeardown(stop);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      unregister();
      stop();
    };
  }, [userId, interval, store]);
}
