import { cacheChat, chatScopeKey } from "./chatCache";
import { messageHistoryState } from "./messageHistory";
import type { AppStore } from "./loaders";
import type {
  AgentStatus,
  ChatMode,
  ChannelMessagesResponse,
  PrivateMessagesResponse,
  SessionBootstrapResponse,
  Id,
  Message,
  MessageRevision,
  MessageSyncCursor,
} from "../types";

interface MessageSyncResponse {
  messages?: Message[];
  message_revision?: MessageRevision;
  reset_revision?: MessageRevision;
  next_after_id?: Id;
  mode?: "full" | "delta" | "history";
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
  const resetRevision = result.reset_revision ?? previous?.resetRevision;
  return {
    afterId: responseAfterId(result, previous),
    revision,
    ...(resetRevision === undefined ? {} : { resetRevision }),
  };
}

/** One commit path for bootstrap, latest-page reads and forward deltas. */
export function applyMessageResponse(
  store: AppStore,
  mode: ChatMode,
  scopeId: string,
  result: ChannelMessagesResponse | PrivateMessagesResponse | SessionBootstrapResponse,
  acceptStatus = true,
  authoritativeStatus = true,
): void {
  const state = store.getState();
  const key = chatScopeKey(mode, scopeId);
  const current = mode === "private" ? state.privateMessages : state.messages;
  const pending = state.pendingMessages.filter(
    (message) => message.scope_type === mode && String(message.scope_id) === scopeId,
  );
  let messages = result.messages || [];
  if ("mode" in result && result.mode === "delta") {
    const pendingIds = new Set(pending.map((message) => String(message.id)));
    const merged = new Map(
      current.filter((message) => !pendingIds.has(String(message.id)))
        .map((message) => [String(message.id), message]),
    );
    for (const message of messages) merged.set(String(message.id), message);
    messages = [...merged.values()].sort((left, right) => Number(left.id) - Number(right.id));
  }
  const nextMessages = [...messages, ...pending];
  // Suppress redundant transport snapshots, not explicit store transitions.
  if (JSON.stringify(current) !== JSON.stringify(nextMessages)) {
    store.dispatch({
      type: mode === "private" ? "SET_PRIVATE_MESSAGES" : "SET_MESSAGES",
      payload: nextMessages,
    });
  }
  if (acceptStatus) applyAgentStatus(store, mode, scopeId, result.agent_status, authoritativeStatus);
  if (mode === "channel") {
    const typing = "typing" in result ? result.typing || [] : [];
    if (JSON.stringify(state.typingUsers) !== JSON.stringify(typing)) {
      store.dispatch({ type: "SET_TYPING_USERS", payload: typing });
    }
  }
  const cursor = messageSyncCursor(result, state.messageSyncCursors[key]);
  if (cursor) store.dispatch({ type: "SET_MESSAGE_SYNC_CURSOR", payload: { key, cursor } });
  const history = "mode" in result && result.mode === "delta"
    ? state.messageHistory[key]
    : messageHistoryState(result, state.messageHistory[key]);
  if (history) store.dispatch({ type: "SET_MESSAGE_HISTORY", payload: { key, history } });
  cacheChat(store, mode, scopeId, messages, cursor, history);
}

/** The reducer retains ordering guards for the server's second-granularity status. */
export function applyAgentStatus(
  store: AppStore,
  mode: ChatMode,
  scopeId: string,
  status: AgentStatus | null | undefined,
  authoritative = false,
): void {
  if (status) store.dispatch({
    type: "SET_AGENT_STATUS",
    payload: { mode, scopeId, status, authoritative },
  });
}
