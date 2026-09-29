/* One active-scope EventSource. The browser owns transient reconnects;
   disconnected polling handles terminal failures and session/access revocation. */

import { useEffect, useState } from "react";
import { getApiSessionGeneration } from "../lib/api";
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
    const mode: ChatMode = view === "private" ? "private" : "channel";
    const scopeId = mode === "private" ? String(userId) : String(activeChannelId || "");
    const previewScope: AgentPreviewScope = {
      scope_type: mode,
      scope_id: scopeId,
    };
    // Reject events from a previous scope or login generation.
    let disposed = false;
    const generation = getApiSessionGeneration();
    const ownsScope = () => !disposed
      && generation === getApiSessionGeneration()
      && String(store.getState().user?.id) === String(userId)
      && currentScopeStreamUrl(store.getState()) === url;

    const close = () => {
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
      if (!ownsScope()) return;
      if (es && es.readyState !== 2) return; // already connected to this scope
      close();
      const current = new EventSource(url, { withCredentials: true });
      es = current;
      current.addEventListener("open", () => {
        if (es !== current || !ownsScope()) return;
        setConnected(true);
        void refreshActiveChat(store);
      });
      current.addEventListener("update", (event) => {
        if (es !== current || !ownsScope()) return;
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
        if (es !== current || !ownsScope()) return;
        setConnected(false);
        // EventSource hides HTTP status; a scoped GET preserves 401 handling and
        // reconciles archived/revoked channels. Native reconnect stays untouched.
        void refreshActiveChat(store);
      });
    };

    const onVisibility = () => {
      if (!document.hidden && ownsScope()) {
        open();
        void refreshActiveChat(store);
      }
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
