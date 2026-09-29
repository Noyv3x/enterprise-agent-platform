/* Low-frequency fallback only while realtime is disconnected and visible.
   Reconnect/visibility catch-up belongs to useRealtime. */

import { useEffect } from "react";
import { registerSessionTeardown } from "../data/sessionActions";
import { refreshActiveChat } from "../data/chatActions";
import { useStore, useStoreHandle } from "../store/useStore";

const POLL_INTERVAL_MS = 30_000;

export function usePolling(enabled: boolean): void {
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
