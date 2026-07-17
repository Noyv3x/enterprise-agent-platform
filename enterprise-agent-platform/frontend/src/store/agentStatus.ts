import type { AgentStatus, AgentStatuses } from "../types";

const ACTIVE_STATES = new Set(["queued", "replying", "approval"]);
const TERMINAL_STATES = new Set(["idle", "complete", "error"]);

function timestamp(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestStreamTimestamp(status: AgentStatus): number {
  return Math.max(
    timestamp(status.stream_message?.updated_at),
    ...(status.stream_messages || []).map((stream) => timestamp(stream.updated_at)),
  );
}

function groupStateRank(state: unknown): number {
  switch (String(state || "")) {
    case "collecting":
      return 1;
    case "reserved":
      return 2;
    case "accepted":
      return 3;
    case "injected":
      return 4;
    default:
      return 0;
  }
}

function hasApprovalResolution(status: AgentStatus): boolean {
  return (status.activity || []).some((step) =>
    String(step.stage || "").toLowerCase().startsWith("approval.responded"),
  );
}

function streamText(status: AgentStatus): string {
  return [
    ...(status.stream_messages || []).map((stream) => stream.content || ""),
    status.stream_message?.content || "",
  ].join("");
}

function sameLifecycle(current: AgentStatus, incoming: AgentStatus): boolean {
  const sameRun = !!current.run_id && current.run_id === incoming.run_id;
  const sameGroup =
    !!current.input_group_id && current.input_group_id === incoming.input_group_id;
  return sameRun || sameGroup;
}

/**
 * Merge an Agent status snapshot from any transport.
 *
 * `updated_at` is authoritative when it differs: a strictly newer snapshot may
 * legitimately clear a previous stream or shrink an input group after a joined
 * input falls back. Equal-second snapshots need structural tie-breakers because
 * the platform clock is second-granularity.
 */
export function mergeAgentStatus(
  current: AgentStatus | null | undefined,
  incoming: AgentStatus | null | undefined,
  { authoritative = false }: { authoritative?: boolean } = {},
): AgentStatus | null {
  if (!incoming) return current || null;
  if (!current) return incoming;

  const currentUpdated = timestamp(current.updated_at);
  const incomingUpdated = timestamp(incoming.updated_at);
  if (currentUpdated && incomingUpdated && incomingUpdated !== currentUpdated) {
    return incomingUpdated > currentUpdated ? incoming : current;
  }
  // A scope transport fence proves that no mutation or newer GET can have
  // overtaken this response. Equal-second snapshots may therefore clear or
  // shrink state without structural guesswork.
  if (authoritative) return incoming;

  const related = sameLifecycle(current, incoming);
  const currentStarted = timestamp(current.started_at);
  const incomingStarted = timestamp(incoming.started_at);
  if (!related && currentStarted && incomingStarted && currentStarted !== incomingStarted) {
    return incomingStarted > currentStarted ? incoming : current;
  }

  const currentState = String(current.state || "");
  const incomingState = String(incoming.state || "");
  if (!related) {
    if (TERMINAL_STATES.has(currentState) && ACTIVE_STATES.has(incomingState)) {
      // A run that started at or after the terminal snapshot is a new lifecycle;
      // an older active snapshot is a delayed poll response.
      return incomingStarted && incomingStarted >= currentUpdated ? incoming : current;
    }
    if (ACTIVE_STATES.has(currentState) && TERMINAL_STATES.has(incomingState)) {
      // An idle snapshot captured immediately before this run must not cancel it.
      return currentStarted && currentStarted >= incomingUpdated ? current : incoming;
    }
    return incoming;
  }

  const currentGroup = current.active_input_group;
  const incomingGroup = incoming.active_input_group;
  const currentCount = Number(currentGroup?.message_count || 0);
  const incomingCount = Number(incomingGroup?.message_count || 0);
  const currentQueued = Number(current.queued_count || 0);
  const incomingQueued = Number(incoming.queued_count || 0);
  if (incomingCount > currentCount) return incoming;
  if (incomingCount < currentCount) {
    // A same-second shrink is legitimate when the removed input was moved back
    // to the ordinary queue. Otherwise it is the usual shape of a stale poll.
    return incomingQueued > currentQueued ? incoming : current;
  }
  if (currentQueued !== incomingQueued) return incomingQueued > currentQueued ? incoming : current;

  const currentRank = groupStateRank(currentGroup?.state);
  const incomingRank = groupStateRank(incomingGroup?.state);
  if (currentRank !== incomingRank) return incomingRank > currentRank ? incoming : current;

  if (incomingState === "approval" && currentState !== "approval") return incoming;
  if (currentState === "approval" && incomingState !== "approval") {
    return hasApprovalResolution(incoming) ? incoming : current;
  }
  if (ACTIVE_STATES.has(currentState) && TERMINAL_STATES.has(incomingState)) return incoming;
  if (TERMINAL_STATES.has(currentState) && ACTIVE_STATES.has(incomingState)) return current;

  const currentStreamUpdated = latestStreamTimestamp(current);
  const incomingStreamUpdated = latestStreamTimestamp(incoming);
  if (currentStreamUpdated !== incomingStreamUpdated) {
    return incomingStreamUpdated > currentStreamUpdated ? incoming : current;
  }

  const currentText = streamText(current);
  const incomingText = streamText(incoming);
  if (currentText !== incomingText) {
    if (incomingText.startsWith(currentText)) return incoming;
    if (currentText.startsWith(incomingText)) return current;
  }

  if ((incoming.activity || []).length !== (current.activity || []).length) {
    return (incoming.activity || []).length > (current.activity || []).length
      ? incoming
      : current;
  }
  return incoming;
}

export function mergeAgentStatuses(
  current: AgentStatuses,
  incoming: AgentStatuses,
): AgentStatuses {
  const channels: AgentStatuses["channels"] = { ...current.channels };
  for (const [scopeId, status] of Object.entries(incoming.channels)) {
    channels[scopeId] = mergeAgentStatus(current.channels[scopeId], status) || status;
  }
  return {
    channels,
    private: mergeAgentStatus(current.private, incoming.private),
  };
}
