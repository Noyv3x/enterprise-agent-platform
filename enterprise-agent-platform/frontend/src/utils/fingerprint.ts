/* =====================================================================
   Change-detection fingerprints — ported from legacy-app.js:2875-2936.
   Used by the realtime layer to suppress no-op re-renders (so identical
   poll/SSE payloads don't disturb scroll/focus). Pure; no store reads.
   ===================================================================== */

import type { AgentStatus, ChatMode, Message, TypingUser } from "../types";

function scopeTypeFor(mode: ChatMode): "private" | "channel" {
  return mode === "private" ? "private" : "channel";
}

function flattenActivity(activity: AgentStatus["activity"]): string[] {
  return (activity || []).map(
    (item) =>
      `${item.source || ""}:${item.stage}:${item.label}:${item.detail}:${item.line || ""}:${item.tool_status || ""}:${item.at}`,
  );
}

export function messageFingerprint(message: Message): unknown {
  const work = message.metadata?.agent_work || null;
  return {
    id: message.id,
    author_type: message.author_type,
    user_id: message.user_id,
    username: message.username,
    content: message.content,
    attachments: (message.attachments || []).map((item) => ({
      id: item.id,
      filename: item.filename,
      mime_type: item.mime_type,
      size_bytes: item.size_bytes,
      url: item.url,
    })),
    created_at: message.created_at,
    pending: !!message.metadata?.local_pending,
    agent_work: work
      ? {
          run_id: work.run_id,
          state: work.state,
          current_step: work.current_step || "",
          activity: flattenActivity(work.activity),
        }
      : null,
  };
}

export function agentStatusFingerprint(status: AgentStatus | null | undefined): unknown {
  if (!status) return null;
  return {
    run_id: status.run_id || "",
    state: status.state,
    queued_count: status.queued_count || 0,
    current_step: status.current_step || "",
    activity: flattenActivity(status.activity),
    stream_message: status.stream_message
      ? {
          id: status.stream_message.id,
          content: status.stream_message.content || "",
          updated_at: status.stream_message.updated_at || 0,
        }
      : null,
    stream_messages: (status.stream_messages || []).map(
      (item) => `${item.id}:${item.content || ""}:${item.updated_at || 0}`,
    ),
    replying_to: status.replying_to
      ? {
          id: status.replying_to.id,
          username: status.replying_to.username,
          content: status.replying_to.content,
          created_at: status.replying_to.created_at,
        }
      : null,
  };
}

/** A deep JSON change-detector for the active chat scope (legacy chatSnapshot).
 *  Inputs are passed explicitly so this stays store-agnostic. */
export function chatSnapshot(
  mode: ChatMode,
  scopeId: string,
  messages: Message[],
  agentStatus: AgentStatus | null | undefined,
  typingUsers: TypingUser[],
): string {
  return JSON.stringify({
    scope: `${scopeTypeFor(mode)}:${scopeId || ""}`,
    messages: messages.map(messageFingerprint),
    agent: agentStatusFingerprint(agentStatus),
    typing:
      mode === "channel"
        ? typingUsers.map((item) => ({ user_id: item.user_id, username: item.username }))
        : [],
  });
}
