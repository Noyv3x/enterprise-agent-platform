/* =====================================================================
   Data layer — typed thunks over the store handle. Each calls api() then
   dispatches SET_* actions; loaders themselves
   never trigger a render (the store notifies subscribers). Endpoint → state
   mapping preserves the established ordering and guards (loadInitial fan-out,
   channel-switch race guard, mergePendingMessages,
   token-usage day re-sync, audit ordering, Promise.all
   batches).
   ===================================================================== */

import { api } from "../lib/api";
import { endpoints } from "../lib/endpoints";
import type { Store } from "../lib/store";
import { scopeIdFor, scopeTypeFor } from "../store/selectors";
import { cacheChat, chatScopeKey } from "./chatCache";
import { messageSyncCursor } from "./messageSync";
import { messageHistoryState } from "./messageHistory";
import {
  isScopeReadCurrent,
  isStatusReadCurrent,
  issueStatusRead,
} from "./statusFence";
import type {
  Action,
  AgentRuntimeConfigResponse,
  AgentStatus,
  AppState,
  AuditChannelMessagesResponse,
  AutoUpdateConfigResponse,
  BrandingSnapshot,
  ChannelMessagesResponse,
  ChannelsResponse,
  ChatMode,
  DocumentsResponse,
  Id,
  KnowledgeConfigResponse,
  KnowledgeStatusResponse,
  Message,
  OAuthProvidersResponse,
  PermissionGroupsResponse,
  PrivateConversationsResponse,
  PrivateMessagesResponse,
  PrivateTelegramResponse,
  RuntimeResponse,
  SessionBootstrapResponse,
  SecretsResponse,
  SecurityConfigResponse,
  TelegramConfigResponse,
  TokenUsageResponse,
  AuditPrivateMessagesResponse,
  UsersResponse,
} from "../types";

/** The store handle the thunks operate over (getState + dispatch). */
export type AppStore = Store<AppState, Action>;

const RUNTIME_STATUS_RETRY_MS = 1_500;
const MAX_RUNTIME_STATUS_RETRIES = 24;
interface RuntimeRefreshRetry {
  timer: ReturnType<typeof setTimeout>;
  attempt: number;
}
const runtimeRefreshRetries = new WeakMap<AppStore, RuntimeRefreshRetry>();

/* ----------------------------------------------------------- local helpers */

/** Merge server messages with the still-pending optimistic items for a scope. */
function mergePending(
  state: AppState,
  mode: ChatMode,
  scopeId: string,
  messages: Message[],
): Message[] {
  const scopeType = scopeTypeFor(mode);
  const pending = state.pendingMessages.filter(
    (message) => message.scope_type === scopeType && message.scope_id === String(scopeId),
  );
  return [...messages, ...pending];
}

/** Per-scope Agent-status write. The reducer owns the shared version merge; a
 *  transport-fenced read is marked authoritative for equal-second snapshots. */
function applyAgentStatus(
  store: AppStore,
  mode: ChatMode,
  scopeId: string,
  status: AgentStatus | null | undefined,
  authoritative = false,
): void {
  if (!status) return;
  store.dispatch({
    type: "SET_AGENT_STATUS",
    payload: { mode, scopeId, status, authoritative },
  });
}

function applyMessageHistory(
  store: AppStore,
  mode: ChatMode,
  scopeId: string,
  result: ChannelMessagesResponse | PrivateMessagesResponse | SessionBootstrapResponse,
) {
  const key = chatScopeKey(mode, scopeId);
  const history = messageHistoryState(result, store.getState().messageHistory[key]);
  store.dispatch({ type: "SET_MESSAGE_HISTORY", payload: { key, history } });
  return history;
}

/* --------------------------------------------------------------- loaders */

/** Apply the authenticated shell snapshot returned by the compact bootstrap API. */
export function hydrateSessionBootstrap(
  store: AppStore,
  result: SessionBootstrapResponse,
): void {
  const channels = result.channels || [];
  const requestedScope = result.active_scope;
  const requestedChannel = requestedScope?.scope_type === "channel"
    ? channels.find((channel) => String(channel.id) === String(requestedScope.scope_id))
    : undefined;
  const activeChannelId = requestedChannel?.id ?? channels[0]?.id ?? null;
  const mode: ChatMode = requestedScope?.scope_type === "private" ? "private" : "channel";
  const scopeId = mode === "private"
    ? String(result.user.id)
    : String(activeChannelId || requestedScope?.scope_id || "");
  const messages = result.messages || [];

  store.dispatch({ type: "SET_USER", payload: result.user });
  store.dispatch({ type: "SET_CHANNELS", payload: channels });
  store.dispatch({ type: "SET_MENTION_TARGETS", payload: result.mention_targets || [] });
  store.dispatch({ type: "SET_ACTIVE_CHANNEL_ID", payload: activeChannelId });
  store.dispatch({ type: "SET_ACTIVE_VIEW", payload: mode });
  store.dispatch({
    type: mode === "private" ? "SET_PRIVATE_MESSAGES" : "SET_MESSAGES",
    payload: mergePending(store.getState(), mode, scopeId, messages),
  });
  applyAgentStatus(store, mode, scopeId, result.agent_status, true);
  store.dispatch({
    type: "SET_TYPING_USERS",
    payload: mode === "channel" ? result.typing || [] : [],
  });
  const cursor = messageSyncCursor(
    result,
    store.getState().messageSyncCursors[chatScopeKey(mode, scopeId)],
  );
  if (cursor) {
    store.dispatch({
      type: "SET_MESSAGE_SYNC_CURSOR",
      payload: {
        key: chatScopeKey(mode, scopeId),
        cursor,
      },
    });
  }
  const history = applyMessageHistory(store, mode, scopeId, result);
  cacheChat(store, mode, scopeId, messages, cursor, history);
}

export async function loadSessionBootstrap(store: AppStore): Promise<void> {
  const result = await api<SessionBootstrapResponse>(endpoints.sessionBootstrap.path(), {
    skipAuthHandling: true,
  });
  hydrateSessionBootstrap(store, result);
  if (result.active_scope?.scope_type === "private") {
    void loadPrivateTelegram(store).catch(() => undefined);
  }
}

export async function loadChannels(store: AppStore): Promise<void> {
  const result = await api<ChannelsResponse>(endpoints.channels.path());
  store.dispatch({ type: "SET_CHANNELS", payload: result.channels });
  const state = store.getState();
  if (!state.activeChannelId && state.channels.length) {
    store.dispatch({ type: "SET_ACTIVE_CHANNEL_ID", payload: state.channels[0].id });
  }
}

export async function loadChannelMessages(store: AppStore): Promise<void> {
  const activeChannelId = store.getState().activeChannelId;
  if (!activeChannelId) return;
  const channelId = String(activeChannelId);
  const statusRead = issueStatusRead(store, "channel", channelId);
  const result = await api<ChannelMessagesResponse>(endpoints.channelMessages.path(channelId));
  // Channel-switch race guard: discard a response for a channel we left.
  if (String(store.getState().activeChannelId) !== channelId) return;
  if (!isScopeReadCurrent(statusRead)) return;
  store.dispatch({
    type: "SET_MESSAGES",
    payload: mergePending(store.getState(), "channel", channelId, result.messages || []),
  });
  if (isStatusReadCurrent(statusRead)) {
    applyAgentStatus(store, "channel", channelId, result.agent_status, true);
  }
  store.dispatch({ type: "SET_TYPING_USERS", payload: result.typing || [] });
  const cursor = messageSyncCursor(
    result,
    store.getState().messageSyncCursors[chatScopeKey("channel", channelId)],
  );
  if (cursor) {
    store.dispatch({
      type: "SET_MESSAGE_SYNC_CURSOR",
      payload: {
        key: chatScopeKey("channel", channelId),
        cursor,
      },
    });
  }
  const history = applyMessageHistory(store, "channel", channelId, result);
  cacheChat(
    store,
    "channel",
    channelId,
    store.getState().messages,
    cursor,
    history,
  );
}

export async function loadPrivateMessages(store: AppStore): Promise<void> {
  const scopeId = scopeIdFor(store.getState(), "private");
  const statusRead = issueStatusRead(store, "private", scopeId);
  const [result] = await Promise.all([
    api<PrivateMessagesResponse>(endpoints.privateMessages.path()),
    loadPrivateTelegram(store),
  ]);
  if (!isScopeReadCurrent(statusRead)) return;
  store.dispatch({
    type: "SET_PRIVATE_MESSAGES",
    payload: mergePending(store.getState(), "private", scopeId, result.messages || []),
  });
  if (isStatusReadCurrent(statusRead)) {
    applyAgentStatus(store, "private", scopeId, result.agent_status, true);
  }
  const cursor = messageSyncCursor(
    result,
    store.getState().messageSyncCursors[chatScopeKey("private", scopeId)],
  );
  if (cursor) {
    store.dispatch({
      type: "SET_MESSAGE_SYNC_CURSOR",
      payload: {
        key: chatScopeKey("private", scopeId),
        cursor,
      },
    });
  }
  const history = applyMessageHistory(store, "private", scopeId, result);
  cacheChat(
    store,
    "private",
    scopeId,
    store.getState().privateMessages,
    cursor,
    history,
  );
}

function scopeStillVisible(store: AppStore, mode: ChatMode, scopeId: string): boolean {
  const state = store.getState();
  if (mode === "private") {
    return state.activeView === "private" && String(state.user?.id || "") === scopeId;
  }
  return state.activeView === "channel" && String(state.activeChannelId || "") === scopeId;
}

let historyRequestSequence = 0;
const historyRequestOwners = new WeakMap<AppStore, Map<string, number>>();

function claimHistoryRequest(store: AppStore, key: string): number {
  let owners = historyRequestOwners.get(store);
  if (!owners) {
    owners = new Map<string, number>();
    historyRequestOwners.set(store, owners);
  }
  historyRequestSequence += 1;
  owners.set(key, historyRequestSequence);
  return historyRequestSequence;
}

function ownsHistoryRequest(store: AppStore, key: string, requestId: number): boolean {
  return historyRequestOwners.get(store)?.get(key) === requestId;
}

function releaseHistoryRequest(store: AppStore, key: string, requestId: number): void {
  const owners = historyRequestOwners.get(store);
  if (owners?.get(key) !== requestId) return;
  owners.delete(key);
  if (owners.size === 0) historyRequestOwners.delete(store);
}

/** Load one backward page without advancing the independent SSE/after_id cursor. */
export async function loadOlderMessages(
  store: AppStore,
  mode: ChatMode,
  scopeId: string,
): Promise<void> {
  const key = chatScopeKey(mode, scopeId);
  const startedState = store.getState();
  const current = startedState.messageHistory[key];
  if (!current?.hasMore || !current.nextBeforeId || current.loading) return;
  const requestedBeforeId = current.nextBeforeId;
  const requestedPrependVersion = current.prependVersion;
  const requestedResetRevision = startedState.messageSyncCursors[key]?.resetRevision;
  if (requestedResetRevision === undefined) return;
  const requestId = claimHistoryRequest(store, key);
  store.dispatch({
    type: "SET_MESSAGE_HISTORY",
    payload: { key, history: { ...current, loading: true, error: "" } },
  });
  const path = mode === "private"
    ? endpoints.privateMessages.path()
    : endpoints.channelMessages.path(scopeId);
  const query = new URLSearchParams({ before_id: requestedBeforeId, limit: "100" });
  const stillOwnsRequest = (): boolean => {
    const state = store.getState();
    const history = state.messageHistory[key];
    const currentResetRevision = state.messageSyncCursors[key]?.resetRevision;
    return ownsHistoryRequest(store, key, requestId)
      && scopeStillVisible(store, mode, scopeId)
      && Boolean(history?.loading)
      && history?.nextBeforeId === requestedBeforeId
      && history?.prependVersion === requestedPrependVersion
      && String(currentResetRevision) === String(requestedResetRevision);
  };
  const releaseOwnedRequest = (error = ""): void => {
    if (!ownsHistoryRequest(store, key, requestId)) return;
    const history = store.getState().messageHistory[key];
    if (
      history?.loading
      && history.nextBeforeId === requestedBeforeId
      && history.prependVersion === requestedPrependVersion
      && String(store.getState().messageSyncCursors[key]?.resetRevision)
        === String(requestedResetRevision)
    ) {
      store.dispatch({
        type: "SET_MESSAGE_HISTORY",
        payload: { key, history: { ...history, loading: false, error } },
      });
    }
    releaseHistoryRequest(store, key, requestId);
  };
  try {
    const result = await api<ChannelMessagesResponse | PrivateMessagesResponse>(
      `${path}?${query.toString()}`,
    );
    const responseResetRevision = result.reset_revision;
    if (
      !stillOwnsRequest()
      || responseResetRevision === undefined
      || String(responseResetRevision) !== String(requestedResetRevision)
    ) {
      releaseOwnedRequest();
      return;
    }
    if (result.mode && result.mode !== "history") {
      throw new Error("message history endpoint returned an invalid mode");
    }
    store.dispatch({
      type: "PREPEND_MESSAGES",
      payload: {
        mode,
        scopeId,
        messages: result.messages || [],
        nextBeforeId:
          result.has_more_before && result.next_before_id != null
            ? String(result.next_before_id)
            : null,
        hasMore: Boolean(result.has_more_before),
      },
    });
    const state = store.getState();
    cacheChat(
      store,
      mode,
      scopeId,
      mode === "private" ? state.privateMessages : state.messages,
      state.messageSyncCursors[key],
      state.messageHistory[key],
    );
    releaseHistoryRequest(store, key, requestId);
  } catch (error) {
    releaseOwnedRequest(
      scopeStillVisible(store, mode, scopeId)
        ? error instanceof Error ? error.message : String(error)
        : "",
    );
    throw error;
  }
}

export async function loadPrivateTelegram(store: AppStore): Promise<void> {
  const result = await api<PrivateTelegramResponse>(endpoints.privateTelegram.path());
  store.dispatch({ type: "SET_PRIVATE_TELEGRAM", payload: result });
}

export async function loadDocuments(store: AppStore): Promise<void> {
  const result = await api<DocumentsResponse>(endpoints.knowledgeDocuments.path());
  store.dispatch({ type: "SET_DOCUMENTS", payload: result.documents });
  store.dispatch({ type: "SET_KNOWLEDGE_SEARCH", payload: { query: "", results: null } });
}

export async function loadUsers(store: AppStore): Promise<void> {
  const result = await api<UsersResponse>(endpoints.users.path());
  store.dispatch({ type: "SET_USERS", payload: result.users });
}

export async function loadPermissionGroups(store: AppStore): Promise<void> {
  const result = await api<PermissionGroupsResponse>(endpoints.permissionGroups.path());
  store.dispatch({ type: "SET_PERMISSION_GROUPS", payload: result.permission_groups });
}

export async function loadAuditChannelMessages(
  store: AppStore,
  channelId: Id | null = store.getState().messageAudit.auditChannelId,
): Promise<void> {
  if (!channelId) {
    store.dispatch({ type: "PATCH_MESSAGE_AUDIT", payload: { channelMessages: [], channelTotal: 0 } });
    return;
  }
  store.dispatch({ type: "PATCH_MESSAGE_AUDIT", payload: { auditChannelId: String(channelId) } });
  const result = await api<AuditChannelMessagesResponse>(
    endpoints.auditChannelMessages.path(channelId),
  );
  store.dispatch({
    type: "PATCH_MESSAGE_AUDIT",
    payload: { channelMessages: result.messages || [], channelTotal: result.total || 0 },
  });
}

export async function loadPrivateConversations(store: AppStore): Promise<void> {
  const result = await api<PrivateConversationsResponse>(endpoints.privateConversations.path());
  const conversations = result.conversations || [];
  const audit = store.getState().messageAudit;
  const selected = String(audit.auditPrivateUserId || "");
  let auditPrivateUserId = audit.auditPrivateUserId;
  // Reselect when the current selection is no longer present: prefer the first
  // conversation with messages, else the first conversation.
  if (!conversations.some((item) => String(item.user_id) === selected)) {
    const firstWithMessages = conversations.find((item) => (item.message_count || 0) > 0);
    auditPrivateUserId = firstWithMessages
      ? String(firstWithMessages.user_id)
      : String(conversations[0]?.user_id || "");
  }
  store.dispatch({
    type: "PATCH_MESSAGE_AUDIT",
    payload: { privateConversations: conversations, auditPrivateUserId },
  });
}

export async function loadAuditPrivateMessages(
  store: AppStore,
  userId: Id | null = store.getState().messageAudit.auditPrivateUserId,
): Promise<void> {
  if (!userId) {
    store.dispatch({ type: "PATCH_MESSAGE_AUDIT", payload: { privateMessages: [], privateTotal: 0 } });
    return;
  }
  store.dispatch({ type: "PATCH_MESSAGE_AUDIT", payload: { auditPrivateUserId: String(userId) } });
  const result = await api<AuditPrivateMessagesResponse>(
    endpoints.auditPrivateMessages.path(userId),
  );
  store.dispatch({
    type: "PATCH_MESSAGE_AUDIT",
    payload: { privateMessages: result.messages || [], privateTotal: result.total || 0 },
  });
}

export async function loadSecrets(store: AppStore): Promise<void> {
  const result = await api<SecretsResponse>(endpoints.secrets.path());
  store.dispatch({ type: "SET_SECRETS", payload: result.secrets });
}

export async function loadOAuthProviders(store: AppStore): Promise<void> {
  store.dispatch({
    type: "SET_OAUTH_PROVIDERS",
    payload: await api<OAuthProvidersResponse>(endpoints.oauthProviders.path()),
  });
}

export async function loadRuntime(store: AppStore): Promise<void> {
  const existing = runtimeRefreshRetries.get(store);
  if (existing) clearTimeout(existing.timer);
  runtimeRefreshRetries.delete(store);
  const result = await api<RuntimeResponse>(endpoints.runtime.path());
  store.dispatch({ type: "SET_RUNTIMES", payload: result });
  scheduleRuntimeStatusRefresh(store, result, 0);
}

function scheduleRuntimeStatusRefresh(
  store: AppStore,
  result: RuntimeResponse,
  attempt: number,
): void {
  if (
    attempt >= MAX_RUNTIME_STATUS_RETRIES ||
    !Object.values(result).some((runtime) => runtime.status_stale)
  ) {
    runtimeRefreshRetries.delete(store);
    return;
  }
  const timer = setTimeout(async () => {
    const scheduled = runtimeRefreshRetries.get(store);
    if (!scheduled || scheduled.timer !== timer) return;
    runtimeRefreshRetries.delete(store);
    if (!store.getState().user) return;
    try {
      const refreshed = await api<RuntimeResponse>(
        endpoints.runtime.path(),
      );
      store.dispatch({ type: "SET_RUNTIMES", payload: refreshed });
      scheduleRuntimeStatusRefresh(store, refreshed, attempt + 1);
    } catch {
      if (store.getState().user) {
        scheduleRuntimeStatusRefresh(store, result, attempt + 1);
      }
    }
  }, RUNTIME_STATUS_RETRY_MS);
  runtimeRefreshRetries.set(store, { timer, attempt });
}

export function clearRuntimeStatusRefresh(store: AppStore): void {
  const retry = runtimeRefreshRetries.get(store);
  if (retry) clearTimeout(retry.timer);
  runtimeRefreshRetries.delete(store);
}

export async function loadSecurityConfig(store: AppStore): Promise<void> {
  store.dispatch({
    type: "SET_SECURITY_CONFIG",
    payload: await api<SecurityConfigResponse>(endpoints.securityConfig.path()),
  });
}

export async function loadAgentRuntimeConfig(store: AppStore): Promise<void> {
  store.dispatch({
    type: "SET_AGENT_RUNTIME_CONFIG",
    payload: await api<AgentRuntimeConfigResponse>(endpoints.agentRuntimeConfig.path()),
  });
}

export async function loadTelegramConfig(store: AppStore): Promise<void> {
  store.dispatch({
    type: "SET_TELEGRAM_CONFIG",
    payload: await api<TelegramConfigResponse>(endpoints.telegramConfig.path()),
  });
}

export async function loadAutoUpdateConfig(store: AppStore): Promise<void> {
  store.dispatch({
    type: "SET_AUTO_UPDATE_CONFIG",
    payload: await api<AutoUpdateConfigResponse>(endpoints.autoUpdateConfig.path()),
  });
}

export async function loadBrandingConfig(store: AppStore): Promise<void> {
  store.dispatch({
    type: "SET_BRANDING_CONFIG",
    payload: await api<BrandingSnapshot>(endpoints.brandingConfig.path()),
  });
}

export async function loadKnowledgeConfig(store: AppStore): Promise<void> {
  store.dispatch({
    type: "SET_KNOWLEDGE_CONFIG",
    payload: await api<KnowledgeConfigResponse>(endpoints.knowledgeConfig.path()),
  });
}

export async function loadKnowledgeStatus(store: AppStore): Promise<void> {
  store.dispatch({
    type: "SET_KNOWLEDGE_STATUS",
    payload: await api<KnowledgeStatusResponse>(endpoints.knowledgeStatus.path()),
  });
}

export async function loadKnowledgeAdmin(store: AppStore): Promise<void> {
  await Promise.all([loadKnowledgeConfig(store), loadKnowledgeStatus(store)]);
}

export async function loadTokenUsage(store: AppStore): Promise<void> {
  const prevDays = store.getState().tokenUsageDays;
  const result = await api<TokenUsageResponse>(endpoints.tokenUsage.path(prevDays || 30, 200));
  store.dispatch({ type: "SET_TOKEN_USAGE", payload: result });
  store.dispatch({
    type: "SET_TOKEN_USAGE_DAYS",
    payload: result.window?.days || prevDays || 30,
  });
}

/* --------------------------------------------------------- orchestrators */

export async function loadMessageAudit(store: AppStore): Promise<void> {
  if (!store.getState().channels.length) await loadChannels(store);
  const state = store.getState();
  const defaultChannel = state.activeChannelId || state.channels[0]?.id;
  if (!state.messageAudit.auditChannelId && defaultChannel) {
    store.dispatch({
      type: "PATCH_MESSAGE_AUDIT",
      payload: { auditChannelId: String(defaultChannel) },
    });
  }
  // Conversations must resolve before private messages: the auto-select of
  // auditPrivateUserId happens inside loadPrivateConversations.
  await Promise.all([
    loadAuditChannelMessages(store, store.getState().messageAudit.auditChannelId),
    loadPrivateConversations(store),
  ]);
  await loadAuditPrivateMessages(store, store.getState().messageAudit.auditPrivateUserId);
}
