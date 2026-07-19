import type { Store } from "../lib/store";
import type {
  Action,
  AppState,
  ChatMode,
  Message,
  MessageSyncCursor,
} from "../types";

type AppStore = Store<AppState, Action>;

const MAX_SCOPES = 8;

interface ChatCacheEntry {
  messages: Message[];
  cursor?: MessageSyncCursor;
}

const caches = new WeakMap<AppStore, Map<string, ChatCacheEntry>>();

export function chatScopeKey(mode: ChatMode, scopeId: string | number): string {
  return `${mode}:${String(scopeId)}`;
}

function cacheFor(store: AppStore): Map<string, ChatCacheEntry> {
  let cache = caches.get(store);
  if (!cache) {
    cache = new Map();
    caches.set(store, cache);
  }
  return cache;
}

export function cacheChat(
  store: AppStore,
  mode: ChatMode,
  scopeId: string,
  messages: Message[],
  cursor?: MessageSyncCursor,
): void {
  const cache = cacheFor(store);
  const key = chatScopeKey(mode, scopeId);
  cache.delete(key);
  cache.set(key, {
    messages: messages.filter((message) => !message.metadata?.local_pending),
    cursor,
  });
  while (cache.size > MAX_SCOPES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function cacheVisibleChat(store: AppStore): void {
  const state = store.getState();
  if (state.activeView === "channel" && state.activeChannelId != null) {
    const scopeId = String(state.activeChannelId);
    cacheChat(
      store,
      "channel",
      scopeId,
      state.messages,
      state.messageSyncCursors[chatScopeKey("channel", scopeId)],
    );
  } else if (state.activeView === "private" && state.user) {
    const scopeId = String(state.user.id);
    cacheChat(
      store,
      "private",
      scopeId,
      state.privateMessages,
      state.messageSyncCursors[chatScopeKey("private", scopeId)],
    );
  }
}

/** Restore a scope synchronously so navigation never exposes another channel. */
export function restoreCachedChat(
  store: AppStore,
  mode: ChatMode,
  scopeId: string,
): boolean {
  const cache = cacheFor(store);
  const key = chatScopeKey(mode, scopeId);
  const entry = cache.get(key);
  if (!entry) return false;
  cache.delete(key);
  cache.set(key, entry);
  const pending = store.getState().pendingMessages.filter(
    (message) =>
      message.scope_type === mode &&
      String(message.scope_id) === String(scopeId),
  );
  store.dispatch({
    type: mode === "private" ? "SET_PRIVATE_MESSAGES" : "SET_MESSAGES",
    payload: [...entry.messages, ...pending],
  });
  if (entry.cursor !== undefined) {
    store.dispatch({
      type: "SET_MESSAGE_SYNC_CURSOR",
      payload: { key, cursor: entry.cursor },
    });
  }
  return true;
}

export function upsertCachedMessage(
  store: AppStore,
  mode: ChatMode,
  scopeId: string,
  message: Message | null | undefined,
): void {
  if (!message) return;
  const cache = cacheFor(store);
  const key = chatScopeKey(mode, scopeId);
  const entry = cache.get(key);
  if (!entry) return;
  const index = entry.messages.findIndex((item) => String(item.id) === String(message.id));
  const messages = [...entry.messages];
  if (index === -1) messages.push(message);
  else messages[index] = message;
  cache.delete(key);
  cache.set(key, { ...entry, messages });
}

export function clearChatCache(store: AppStore): void {
  caches.delete(store);
}
