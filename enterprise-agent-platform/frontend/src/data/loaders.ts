/* =====================================================================
   Data layer — every legacy load* reborn as a typed thunk over the store
   handle. Each calls api() then dispatches SET_* actions; loaders themselves
   never trigger a render (the store notifies subscribers). Endpoint → state
   mapping preserves the established ordering and guards (loadInitial fan-out,
   channel-switch race guard, mergePendingMessages,
   mention-error swallow, token-usage day re-sync, audit ordering, Promise.all
   batches).
   ===================================================================== */

import { api, isApiRequestCancelled } from "../lib/api";
import { endpoints } from "../lib/endpoints";
import type { Store } from "../lib/store";
import { scopeIdFor, scopeTypeFor } from "../store/selectors";
import { isStatusReadCurrent, issueStatusRead } from "./statusFence";
import type {
  Action,
  AgentRuntimeConfigResponse,
  AgentStatus,
  AppState,
  AuditChannelMessagesResponse,
  AutoUpdateConfigResponse,
  ChannelMessagesResponse,
  ChannelsResponse,
  ChatMode,
  CogneeConfigResponse,
  DocumentsResponse,
  Id,
  MentionTargetsResponse,
  Message,
  OAuthProvidersResponse,
  PermissionGroupsResponse,
  PrivateConversationsResponse,
  PrivateMessagesResponse,
  PrivateTelegramResponse,
  RuntimeResponse,
  SecretsResponse,
  SecurityConfigResponse,
  TelegramConfigResponse,
  TokenUsageResponse,
  AuditPrivateMessagesResponse,
  UsersResponse,
} from "../types";

/** The store handle the thunks operate over (getState + dispatch). */
export type AppStore = Store<AppState, Action>;

/* ----------------------------------------------------------- local helpers */

/** Merge server messages with the still-pending optimistic items for a scope
 *  (legacy mergePendingMessages, legacy-app.js:2937-2940). */
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

/* --------------------------------------------------------------- loaders */

export async function loadInitial(store: AppStore): Promise<void> {
  await Promise.all([loadChannels(store), loadMentionTargets(store)]);
  await loadChannelMessages(store);
}

export async function loadChannels(store: AppStore): Promise<void> {
  const result = await api<ChannelsResponse>(endpoints.channels.path());
  store.dispatch({ type: "SET_CHANNELS", payload: result.channels });
  const state = store.getState();
  if (!state.activeChannelId && state.channels.length) {
    store.dispatch({ type: "SET_ACTIVE_CHANNEL_ID", payload: state.channels[0].id });
  }
}

export async function loadMentionTargets(store: AppStore): Promise<void> {
  try {
    const result = await api<MentionTargetsResponse>(endpoints.mentionTargets.path());
    store.dispatch({ type: "SET_MENTION_TARGETS", payload: result.targets || [] });
  } catch (error) {
    // A session reset invalidates the whole response, including this fallback.
    // Re-throw so an outgoing account's cancelled loader cannot clear data that
    // already belongs to the newly authenticated account.
    if (isApiRequestCancelled(error)) throw error;
    // Mention autocomplete is best-effort; never block hydration on it.
    store.dispatch({ type: "SET_MENTION_TARGETS", payload: [] });
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
  if (!isStatusReadCurrent(statusRead)) return;
  store.dispatch({
    type: "SET_MESSAGES",
    payload: mergePending(store.getState(), "channel", channelId, result.messages || []),
  });
  applyAgentStatus(store, "channel", channelId, result.agent_status, true);
  store.dispatch({ type: "SET_TYPING_USERS", payload: result.typing || [] });
}

export async function loadPrivateMessages(store: AppStore): Promise<void> {
  const scopeId = scopeIdFor(store.getState(), "private");
  const statusRead = issueStatusRead(store, "private", scopeId);
  const [result] = await Promise.all([
    api<PrivateMessagesResponse>(endpoints.privateMessages.path()),
    loadPrivateTelegram(store),
  ]);
  if (!isStatusReadCurrent(statusRead)) return;
  store.dispatch({
    type: "SET_PRIVATE_MESSAGES",
    payload: mergePending(store.getState(), "private", scopeId, result.messages || []),
  });
  applyAgentStatus(store, "private", scopeId, result.agent_status, true);
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
  store.dispatch({ type: "SET_RUNTIMES", payload: await api<RuntimeResponse>(endpoints.runtime.path()) });
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

export async function loadCogneeConfig(store: AppStore): Promise<void> {
  store.dispatch({
    type: "SET_COGNEE_CONFIG",
    payload: await api<CogneeConfigResponse>(endpoints.cogneeConfig.path()),
  });
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

export async function loadSettings(store: AppStore): Promise<void> {
  await Promise.all([
    loadSecrets(store),
    loadRuntime(store),
    loadSecurityConfig(store),
    loadAgentRuntimeConfig(store),
    loadTelegramConfig(store),
    loadAutoUpdateConfig(store),
    loadCogneeConfig(store),
    loadOAuthProviders(store),
  ]);
}

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

export async function loadAdminPanel(store: AppStore): Promise<void> {
  await Promise.all([
    loadUsers(store),
    loadPermissionGroups(store),
    loadSettings(store),
    loadMessageAudit(store),
    loadTokenUsage(store),
  ]);
}
