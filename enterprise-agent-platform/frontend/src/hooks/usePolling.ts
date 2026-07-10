/* usePolling — the 4s safety-net poll behind the SSE stream (legacy startPolling/
   stopPolling, legacy-app.js:3285-3302). A setInterval(refreshActiveChat, 4000)
   gated on an authenticated user and tab visibility; the re-entrancy mutex lives
   inside refreshActiveChat (the shared pollInFlight). Hidden tabs clear the
   interval; becoming visible does an immediate catch-up refresh and restarts it
   (legacy visibilitychange branch). The interval is also torn down on logout/401
   via the session teardown registry. */

import { useEffect } from "react";
import { registerSessionTeardown } from "../data/sessionActions";
import { refreshActiveChat } from "../data/chatActions";
import { useStore, useStoreHandle } from "../store/useStore";

const POLL_INTERVAL_MS = 4000;

export function usePolling(enabled = true): void {
  const store = useStoreHandle();
  const userId = useStore((state) => state.user?.id);

  useEffect(() => {
    if (!userId || !enabled) return;

    let timer: number | null = null;

    const stop = () => {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const start = () => {
      if (timer == null) timer = window.setInterval(() => void refreshActiveChat(store), POLL_INTERVAL_MS);
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
  }, [userId, enabled, store]);
}
