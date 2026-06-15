/* useTypingNotifier — the React port of legacy notifyTyping/sendTypingState
   (legacy-app.js:3037-3063). Channel-only; no-op in private mode.

   typingState lives in a ref (mutable, not render state). The 1800ms throttle
   and 3500ms auto-stop windows are preserved verbatim; the POST /typing errors
   are swallowed. Returns notify(isTyping) which the composer fires on input,
   on submit, on emptying, and on compositionend. On unmount the stop timer is
   cleared and the active flag reset (matching legacy stopPolling, which does NOT
   send a final typing:false). */

import { useCallback, useEffect, useRef } from "react";
import { api } from "../lib/api";
import { endpoints } from "../lib/endpoints";
import type { ChatMode } from "../types";

const THROTTLE_MS = 1800;
const AUTO_STOP_MS = 3500;

interface TypingState {
  key: string | null;
  active: boolean;
  lastSent: number;
  stopTimer: number | null;
}

export type NotifyTyping = (isTyping: boolean) => void;

export function useTypingNotifier(mode: ChatMode, scopeId: string): NotifyTyping {
  const stateRef = useRef<TypingState>({ key: null, active: false, lastSent: 0, stopTimer: null });

  const send = useCallback((channelId: string, isTyping: boolean) => {
    const state = stateRef.current;
    state.key = `channel:${channelId}`;
    state.active = isTyping;
    state.lastSent = Date.now();
    api(endpoints.channelTyping.path(channelId), {
      method: "POST",
      body: JSON.stringify({ typing: isTyping }),
    }).catch(() => {
      /* typing pings are best-effort */
    });
  }, []);

  const notify = useCallback<NotifyTyping>(
    (isTyping) => {
      if (mode !== "channel" || !scopeId) return;
      const state = stateRef.current;
      const key = `channel:${scopeId}`;
      if (state.stopTimer != null) {
        clearTimeout(state.stopTimer);
        state.stopTimer = null;
      }
      if (!isTyping) {
        send(scopeId, false);
        return;
      }
      const now = Date.now();
      if (state.key !== key || !state.active || now - state.lastSent > THROTTLE_MS) {
        send(scopeId, true);
      }
      state.stopTimer = window.setTimeout(() => send(scopeId, false), AUTO_STOP_MS);
    },
    [mode, scopeId, send],
  );

  useEffect(() => {
    const state = stateRef.current;
    return () => {
      if (state.stopTimer != null) {
        clearTimeout(state.stopTimer);
        state.stopTimer = null;
      }
      state.active = false;
    };
  }, []);

  return notify;
}
