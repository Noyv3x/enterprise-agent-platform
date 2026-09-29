/* Row memoization observes rendered message fields. */

import type { AgentStatus, Message } from "../types";

function flattenActivity(activity: AgentStatus["activity"]): unknown[] {
  return (activity || []).map((item) => ({
    source: item.source || "",
    stage: item.stage || "",
    label: item.label || "",
    detail: item.detail || "",
    line: item.line || "",
    tool: item.tool || "",
    tool_call_id: item.tool_call_id || "",
    tool_status: item.tool_status || "",
    approval_id: item.approval_id || "",
    approval_choice: item.approval_choice || "",
    approval_responder: item.approval_responder || "",
    emoji: item.emoji || "",
    at: item.at || "",
    completed_at: item.completed_at || "",
    sequence: item.sequence || "",
    updated_sequence: item.updated_sequence || "",
    detail_truncated_chars: item.detail_truncated_chars || "",
    parameters: item.parameters || null,
    result: item.result || "",
    result_truncated_chars: item.result_truncated_chars || "",
    omitted_events: item.omitted_events || "",
    omitted_tool_events: item.omitted_tool_events || "",
  }));
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
      preview_url: item.preview_url,
      local_preview: !!item.local_preview,
    })),
    created_at: message.created_at,
    pending: !!message.metadata?.local_pending,
    upload: message.metadata?.upload || null,
    streaming: !!message.metadata?.streaming,
    stream_segment: !!message.metadata?.stream_segment,
    input_group_id: message.metadata?.input_group_id || "",
    processing_mode: message.metadata?.processing_mode || "",
    reply_to_message_ids: message.metadata?.reply_to_message_ids || [],
    durable_job_ids: message.metadata?.durable_job_ids || [],
    scheduled_task: message.metadata?.scheduled_task
      ? {
          schedule_id: message.metadata.scheduled_task.schedule_id,
          schedule_run_id: message.metadata.scheduled_task.schedule_run_id,
          name: message.metadata.scheduled_task.name,
          scheduled_for: message.metadata.scheduled_task.scheduled_for,
        }
      : null,
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
          computer: work.computer || null,
        }
      : null,
  };
}

/** Stable value used by React.memo. */
export function messageFingerprintKey(message: Message): string {
  return JSON.stringify(messageFingerprint(message));
}

