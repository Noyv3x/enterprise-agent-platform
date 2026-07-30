import { useEffect, useState } from "react";
import {
  browserNotificationsEnabled,
  browserNotificationsSupported,
  subscribeBrowserNotifications,
} from "../lib/browserNotifications";
import { endpoints } from "../lib/endpoints";
import { registerSessionTeardown } from "../data/sessionActions";
import { useI18n } from "../i18n";
import { useStore, useStoreHandle } from "../store/useStore";
import type { ChatMode } from "../types";

interface ReplyCompletionEvent {
  message_id?: unknown;
  scope_type?: unknown;
  scope_id?: unknown;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parsePayload(event: MessageEvent<string>): ReplyCompletionEvent | null {
  try {
    const parsed = JSON.parse(event.data || "{}") as unknown;
    return parsed && typeof parsed === "object" ? parsed as ReplyCompletionEvent : null;
  } catch {
    return null;
  }
}

/**
 * Notify once for every newly persisted Agent reply visible to this user while
 * the page remains loaded. The dedicated completion stream is independent of
 * the active chat scope, so navigation and history hydration cannot hide or
 * manufacture completion events.
 */
export function useReplyNotifications(): void {
  const store = useStoreHandle();
  const { t } = useI18n();
  const userId = useStore((state) => state.user?.id);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (userId == null) {
      setEnabled(false);
      return;
    }
    setEnabled(browserNotificationsEnabled(userId));
    return subscribeBrowserNotifications(userId, setEnabled);
  }, [userId]);

  useEffect(() => {
    if (
      userId == null ||
      !enabled ||
      !browserNotificationsSupported() ||
      typeof EventSource === "undefined"
    ) {
      return;
    }

    let source: EventSource | null = new EventSource(endpoints.agentReplyEvents.path(), {
      withCredentials: true,
    });
    let watermark: number | null = null;

    const close = () => {
      if (!source) return;
      try {
        source.close();
      } catch {
        /* ignore */
      }
      source = null;
    };

    const onBaseline = (raw: Event) => {
      const event = raw as MessageEvent<string>;
      const payload = parsePayload(event);
      const next = positiveInteger(payload?.message_id ?? (payload as { watermark?: unknown } | null)?.watermark);
      const eventId = positiveInteger(event.lastEventId);
      const baseline = next ?? eventId;
      if (baseline != null) watermark = watermark == null ? baseline : Math.max(watermark, baseline);
    };

    const onReply = (raw: Event) => {
      const event = raw as MessageEvent<string>;
      const payload = parsePayload(event);
      if (!payload) return;
      const messageId = positiveInteger(payload.message_id) ?? positiveInteger(event.lastEventId);
      const mode = payload.scope_type === "channel" || payload.scope_type === "private"
        ? payload.scope_type as ChatMode
        : null;
      const scopeId = typeof payload.scope_id === "string" ? payload.scope_id : "";
      // The server always emits a baseline first. Fail closed if an intermediary
      // reorders events, and suppress replayed EventSource deliveries by the
      // durable message watermark rather than by currently rendered messages.
      if (messageId == null || watermark == null || messageId <= watermark || !mode || !scopeId) return;
      watermark = messageId;

      if (Notification.permission !== "granted" || (!document.hidden && document.hasFocus())) return;
      const notification = new Notification(t("notifications.reply.title"), {
        body: t("notifications.reply.body"),
        tag: `ubitech-agent-reply-${userId}-${mode}:${scopeId}-${messageId}`,
      });
      notification.onclick = () => {
        window.focus();
        if (mode === "channel") {
          store.dispatch({ type: "SET_ACTIVE_CHANNEL_ID", payload: scopeId });
        }
        store.dispatch({ type: "SET_ACTIVE_VIEW", payload: mode });
        notification.close();
      };
    };

    source.addEventListener("baseline", onBaseline);
    source.addEventListener("reply", onReply);
    const unregister = registerSessionTeardown(close);
    return () => {
      unregister();
      close();
    };
  }, [enabled, store, t, userId]);
}
