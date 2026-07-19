/* useRealtime — the EventSource lifecycle for the active chat scope, replacing
   the legacy per-render syncScopeStream/closeScopeStream (legacy-app.js:3304-3363).

   One stream per active scope. The effect is keyed on
   [user?.id, view, activeChannelId, url] (+ the stable store handle), so it only
   re-opens when the scope URL actually changes — no per-render thrash. Cleanup
   closes the stream and clears the reconnect timer.

   Preserved semantics:
   - "update" events apply ephemeral status/typing directly and synchronize
     messages only when the persisted conversation revision changes;
   - on a terminal close (readyState === 2) we probe GET /api/auth/me (NOT
     skipAuthHandling, so a 401 drops to login) and, if still authed + visible,
     schedule a single 3s reconnect;
   - hidden tabs close the stream and reopen on visible (legacy visibility pause);
   - pagehide closes the stream and pageshow restores it after BFCache resume;
   - logout/401 close it via the session teardown. */

import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { endpoints } from "../lib/endpoints";
import { SSE_RECONNECT_MS } from "../lib/constants";
import { registerSessionTeardown } from "../data/sessionActions";
import {
  applyScopeRealtimeUpdate,
  currentScopeStreamUrl,
  refreshActiveChat,
  type ScopeRealtimeUpdate,
} from "../data/chatActions";
import { publishRealtimePreview } from "../data/realtimeEvents";
import { useStore, useStoreHandle } from "../store/useStore";
import type { AgentPreviewScope, ChatMode } from "../types";

interface RealtimePayload extends ScopeRealtimeUpdate {
  preview?: {
    browser_active?: boolean;
    browserActive?: boolean;
    running_terminal_count?: number;
    runningTerminalCount?: number;
  };
  preview_changed?: boolean;
}

export function useRealtime(): boolean {
  const store = useStoreHandle();
  const userId = useStore((state) => state.user?.id);
  const view = useStore((state) => state.activeView);
  const activeChannelId = useStore((state) => state.activeChannelId);
  const url = useStore(currentScopeStreamUrl);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setConnected(false);
    if (!userId || !url || typeof EventSource === "undefined") return;

    let es: EventSource | null = null;
    let reconnect: number | null = null;
    const mode: ChatMode = view === "private" ? "private" : "channel";
    const scopeId = mode === "private" ? String(userId) : String(activeChannelId || "");
    const previewScope: AgentPreviewScope = {
      scope_type: mode,
      scope_id: scopeId,
    };
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
      if (!disposed) setConnected(false);
    };

    const open = () => {
      if (document.hidden) return;
      if (es && es.readyState !== 2) return; // already connected to this scope
      close();
      const current = new EventSource(url, { withCredentials: true });
      es = current;
      current.addEventListener("open", () => {
        if (es === current && !disposed) setConnected(true);
      });
      current.addEventListener("update", (event) => {
        if (es !== current) return;
        let payload: RealtimePayload;
        try {
          payload = JSON.parse((event as MessageEvent<string>).data || "{}") as RealtimePayload;
        } catch {
          return;
        }
        if (payload.preview || payload.preview_changed) {
          const preview = payload.preview;
          publishRealtimePreview({
            scope: previewScope,
            ...(preview && typeof (preview.browser_active ?? preview.browserActive) === "boolean"
              ? { browserActive: Boolean(preview.browser_active ?? preview.browserActive) }
              : {}),
            ...(preview && Number.isFinite(
              Number(preview.running_terminal_count ?? preview.runningTerminalCount),
            )
              ? {
                  runningTerminalCount: Number(
                    preview.running_terminal_count ?? preview.runningTerminalCount,
                  ),
                }
              : {}),
          });
        }
        if (applyScopeRealtimeUpdate(store, mode, scopeId, payload)) {
          // The SSE snapshot is newer than a GET that may already be in flight;
          // do not let an equal-second response authoritatively roll it back.
          void refreshActiveChat(store, { authoritativeStatus: false });
        }
      });
      current.addEventListener("error", () => {
        if (es !== current) return;
        if (!disposed) setConnected(false);
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
    const onPageShow = () => open();

    open();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    const unregister = registerSessionTeardown(close);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      unregister();
      close();
    };
  }, [userId, view, activeChannelId, url, store]);

  return connected;
}
