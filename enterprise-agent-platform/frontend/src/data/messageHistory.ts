import type { Id, MessageHistoryState } from "../types";

interface MessageHistoryResponse {
  next_before_id?: Id | null;
  has_more_before?: boolean;
}

export function messageHistoryState(
  result: MessageHistoryResponse,
  previous?: MessageHistoryState,
): MessageHistoryState {
  const hasMore = Boolean(result.has_more_before);
  return {
    nextBeforeId: hasMore && result.next_before_id != null
      ? String(result.next_before_id)
      : null,
    hasMore,
    loading: false,
    error: "",
    prependVersion: previous?.prependVersion || 0,
  };
}
