/* useRealtime — the EventSource lifecycle for the active chat scope, replacing
   the legacy per-render syncScopeStream/closeScopeStream (legacy-app.js:3304-3363).

   One stream per active scope. The effect is keyed on
   [user?.id, view, activeChannelId, url] (+ the stable store handle), so it only
   re-opens when the scope URL actually changes — no per-render thrash. Cleanup
   closes the stream and clears the reconnect timer.

   Preserved semantics:
   - "update" events trigger refreshActiveChat (guarded against a stale instance);
   - on a terminal close (readyState === 2) we probe GET /api/auth/me (NOT
     skipAuthHandling, so a 401 drops to login) and, if still authed + visible,
     schedule a single 3s reconnect;
   - hidden tabs close the stream and reopen on visible (legacy visibility pause);
   - pagehide closes the stream; logout/401 close it via the session teardown. */

import { useEffect } from "react";
import { api } from "../lib/api";
import { endpoints } from "../lib/endpoints";
import { SSE_RECONNECT_MS } from "../lib/constants";
import { registerSessionTeardown } from "../data/sessionActions";
import { currentScopeStreamUrl, refreshActiveChat } from "../data/chatActions";
import { useStore, useStoreHandle } from "../store/useStore";

export function useRealtime(): void {
  const store = useStoreHandle();
  const userId = useStore((state) => state.user?.id);
  const view = useStore((state) => state.activeView);
  const activeChannelId = useStore((state) => state.activeChannelId);
  const url = useStore(currentScopeStreamUrl);

  useEffect(() => {
    if (!userId || !url || typeof EventSource === "undefined") return;

    let es: EventSource | null = null;
    let reconnect: number | null = null;
    // Guards the async auth-probe below: if the effect is torn down (scope change,
    // logout) while the probe is in flight, its .then() must not schedule a
    // reconnect that would open a second EventSource bound to the now-stale scope.
    let disposed = false;

    const clearReconnect = () => {
      if (reconnect != null) {
        clearTimeout(reconnect);
        reconnect = null;
      }
    };

    const close = () => {
      clearReconnect();
      if (es) {
        try {
          es.close();
        } catch {
          /* ignore */
        }
        es = null;
      }
    };

    const open = () => {
      if (document.hidden) return;
      if (es && es.readyState !== 2) return; // already connected to this scope
      close();
      const current = new EventSource(url, { withCredentials: true });
      es = current;
      current.addEventListener("update", () => {
        if (es === current) void refreshActiveChat(store);
      });
      current.addEventListener("error", () => {
        if (es !== current) return;
        // readyState 0 = the browser is auto-reconnecting; leave it. readyState 2
        // (CLOSED) is terminal — probe auth, then self-reconnect once if valid.
        if (current.readyState === 2) {
          close();
          api(endpoints.authMe.path())
            .then(() => {
              if (disposed || reconnect != null) return;
              reconnect = window.setTimeout(() => {
                reconnect = null;
                if (!disposed && store.getState().user && !document.hidden) open();
              }, SSE_RECONNECT_MS);
            })
            .catch(() => {
              /* api()'s 401 handling already dropped to login */
            });
        }
      });
    };

    const onVisibility = () => {
      if (document.hidden) close();
      else open();
    };
    const onPageHide = () => close();

    open();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    const unregister = registerSessionTeardown(close);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      unregister();
      close();
    };
  }, [userId, view, activeChannelId, url, store]);
}
