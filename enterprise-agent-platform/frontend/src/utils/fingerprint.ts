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
      `${item.source || ""}:${item.stage}:${item.label}:${item.detail}:${item.line || ""}:${item.tool || ""}:${item.tool_call_id || ""}:${item.tool_status || ""}:${item.approval_id || ""}:${item.approval_choice || ""}:${item.emoji || ""}:${item.at}:${item.completed_at || ""}`,
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
      is_image: !!item.is_image,
      url: item.url,
      download_url: item.download_url,
      local_preview: !!item.local_preview,
    })),
    created_at: message.created_at,
    pending: !!message.metadata?.local_pending,
    streaming: !!message.metadata?.streaming,
    stream_segment: !!message.metadata?.stream_segment,
    scheduled_task: message.metadata?.scheduled_task
      ? {
          schedule_id: message.metadata.scheduled_task.schedule_id,
          schedule_run_id: message.metadata.scheduled_task.schedule_run_id,
          name: message.metadata.scheduled_task.name,
          scheduled_for: message.metadata.scheduled_task.scheduled_for,
        }
      : null,
    knowledge_suggestions: (message.metadata?.knowledge_suggestions || []).map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.summary || "",
      source: item.source || "",
      score: item.score ?? null,
    })),
    agent_work: work
      ? {
          run_id: work.run_id,
          state: work.state,
          current_step: work.current_step || "",
          queued_count: work.queued_count || 0,
          started_at: work.started_at || 0,
          scope_type: work.scope_type || "",
          scope_id: work.scope_id == null ? "" : String(work.scope_id),
          activity: flattenActivity(work.activity),
        }
      : null,
  };
}

/** Stable value used by React.memo. Keeping this beside chatSnapshot ensures
 * realtime suppression and row memoization observe the same render fields. */
export function messageFingerprintKey(message: Message): string {
  return JSON.stringify(messageFingerprint(message));
}

export function agentStatusFingerprint(status: AgentStatus | null | undefined): unknown {
  if (!status) return null;
  return {
    run_id: status.run_id || "",
    state: status.state,
    queued_count: status.queued_count || 0,
    started_at: status.started_at || 0,
    scope_type: status.scope_type || "",
    scope_id: status.scope_id == null ? "" : String(status.scope_id),
    current_step: status.current_step || "",
    activity: flattenActivity(status.activity),
    stream_message: status.stream_message
      ? {
          id: status.stream_message.id,
          content: status.stream_message.content || "",
          updated_at: status.stream_message.updated_at || 0,
          active: status.stream_message.active !== false,
          username: status.stream_message.username || "",
          created_at: status.stream_message.created_at || 0,
        }
      : null,
    stream_messages: (status.stream_messages || []).map((item) => ({
      id: item.id,
      content: item.content || "",
      updated_at: item.updated_at || 0,
      active: item.active !== false,
      username: item.username || "",
      created_at: item.created_at || 0,
    })),
    approval: status.approval
      ? {
          run_id: status.approval.run_id || "",
          command: status.approval.command || "",
          description: status.approval.description || "",
          choices: status.approval.choices || [],
          requested_at: status.approval.requested_at || 0,
        }
      : null,
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
