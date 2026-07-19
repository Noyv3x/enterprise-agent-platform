import type {
  Id,
  Message,
  MessageRevision,
  MessageSyncCursor,
} from "../types";

interface MessageSyncResponse {
  messages?: Message[];
  message_revision?: MessageRevision;
  next_after_id?: Id;
  mode?: "full" | "delta";
}

function responseAfterId(
  result: MessageSyncResponse,
  previous: MessageSyncCursor | undefined,
): string {
  if (result.next_after_id != null) return String(result.next_after_id);
  const messages = result.messages || [];
  const latest = messages[messages.length - 1];
  if (latest?.id != null) return String(latest.id);
  if (result.mode === "delta" && previous) return previous.afterId;
  return "0";
}

/**
 * Build a cursor only from a server synchronization response. Visible messages
 * are deliberately excluded because POST responses can arrive out of order
 * relative to an unread delta.
 */
export function messageSyncCursor(
  result: MessageSyncResponse,
  previous?: MessageSyncCursor,
): MessageSyncCursor | undefined {
  const revision = result.message_revision ?? previous?.revision;
  if (revision === undefined) return undefined;
  return {
    afterId: responseAfterId(result, previous),
    revision,
  };
}
