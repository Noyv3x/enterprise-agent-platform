import { useEffect, useState } from "react";
import { isAgentActive } from "../../store/selectors";
import type { AgentStatus, Message, StreamMsg } from "../../types";
import { hasAgentProcessSteps } from "./AgentWorkCard";

/** Upper bound for showing a finished run whose persisted message has not arrived. */
export const SETTLE_WINDOW_MS = 15_000;

interface TrackedRun {
  scope: string;
  run: string;
  status: AgentStatus;
  streams: StreamMsg[];
  /** Highest persisted message id when the run was first seen live. */
  watermark: number;
  settledAt: number | null;
}

export interface SettlingRun {
  status: AgentStatus;
  streams: StreamMsg[];
}

function runKey(status: AgentStatus): string {
  return status.run_id || `started:${status.started_at ?? ""}`;
}

function persistedWatermark(messages: readonly Message[]): number {
  let latest = 0;
  for (const message of messages) {
    if (message.metadata?.local_pending || message.metadata?.streaming) continue;
    const id = Number(message.id);
    if (Number.isSafeInteger(id) && id > latest) latest = id;
  }
  return latest;
}

function isPersisted(messages: readonly Message[], tracked: TrackedRun): boolean {
  return messages.some((message) => {
    if (message.author_type !== "agent" || message.metadata?.local_pending || message.metadata?.streaming) return false;
    const persistedRun = message.metadata?.agent_work?.run_id;
    if (persistedRun && tracked.status.run_id) return persistedRun === tracked.status.run_id;
    const id = Number(message.id);
    return Number.isSafeInteger(id) && id > tracked.watermark;
  });
}

/**
 * The live status turns idle (or moves to the next queued run) in the same SSE
 * update that announces the new message revision, but the persisted reply only
 * lands after the following message fetch. Keep the finished run's last real
 * snapshot on screen across that gap so the reply never disappears and
 * reappears. It is released as soon as the persisted reply for the run is
 * present, when the scope changes, on a visible error record, or after a
 * bounded window if nothing was persisted.
 */
export function useSettlingRun(
  scope: string,
  status: AgentStatus | null | undefined,
  streams: StreamMsg[],
  messages: readonly Message[],
): SettlingRun | null {
  const [tracked, setTracked] = useState<TrackedRun | null>(null);
  const active = isAgentActive(status);
  const liveKey = status && active ? runKey(status) : null;
  const hasContent = !!status && active && (streams.length > 0 || hasAgentProcessSteps(status));

  let next = tracked;
  if (next && next.scope !== scope) next = null;
  if (status && liveKey && hasContent) {
    if (!next || next.run !== liveKey || next.settledAt !== null) {
      next = {
        scope,
        run: liveKey,
        status,
        streams,
        watermark: next?.run === liveKey ? next.watermark : persistedWatermark(messages),
        settledAt: null,
      };
    } else if (next.status !== status) {
      next = { ...next, status, streams };
    }
  } else if (next && next.settledAt === null && liveKey !== next.run) {
    next = { ...next, settledAt: Date.now() };
  }
  if (next && next.settledAt !== null && (status?.state === "error" || isPersisted(messages, next))) next = null;
  if (next !== tracked) setTracked(next);

  const settledAt = next?.settledAt ?? null;
  useEffect(() => {
    if (settledAt === null) return;
    const timer = window.setTimeout(() => {
      setTracked((current) => (current?.settledAt === settledAt ? null : current));
    }, Math.max(0, settledAt + SETTLE_WINDOW_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [settledAt]);

  return next && next.settledAt !== null ? { status: next.status, streams: next.streams } : null;
}
