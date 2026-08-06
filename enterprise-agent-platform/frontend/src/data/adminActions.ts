/* Admin data and actions for accounts, token usage, message audit,
   configuration, OAuth and secrets. Mutations route through runBusy so the
   global busy state consistently gates admin controls. Confirmation remains a
   render concern handled by audit components through useConfirm(). */

import { api, downloadJson } from "../lib/api";
import { EMPTY_BODY, endpoints } from "../lib/endpoints";
import { toast } from "../context/ToastContext";
import {
  loadAuditChannelMessages,
  loadAuditPrivateMessages,
  loadAgentRuntimeConfig,
  loadAutoUpdateConfig,
  loadBrandingConfig,
  loadChannelMessages,
  loadChannels,
  loadKnowledgeAdmin,
  loadKnowledgeStatus,
  loadInitial,
  loadMessageAudit,
  loadPrivateConversations,
  loadPrivateMessages,
  loadRuntime,
  loadSecrets,
  loadSettings,
  loadTelegramConfig,
  loadTokenUsage,
  loadUsers,
  type AppStore,
} from "./loaders";
import { resetSession, runBusy } from "./sessionActions";
import { ensureAdminPageResource } from "./adminResources";
import { t } from "../i18n";
import type {
  AdminPageId,
  AutoUpdateConfigUpdateRequest,
  BrandingConfigUpdateRequest,
  BrandingLogoDeleteRequest,
  BrandingLogoUpdateRequest,
  BrandingSnapshot,
  ManagerOperation,
  CreateUserRequest,
  DeleteBeforeRequest,
  DeleteClearAllRequest,
  DeleteResultResponse,
  AgentRuntimeConfigUpdateRequest,
  Id,
  ImpersonateUserResponse,
  KnowledgeConfigUpdateRequest,
  OAuthFlowResponse,
  OAuthImportResponse,
  SecurityConfigResponse,
  SecurityConfigUpdateRequest,
  TelegramConfigUpdateRequest,
  UpdateUserRequest,
} from "../types";

/* =============================================================== accounts */

/** Create an account with POST /api/users. `onSuccess` resets the form
 *  fields and runs inside runBusy so it only fires on a successful POST. */
export async function createAccount(
  store: AppStore,
  body: CreateUserRequest,
  onSuccess?: () => void,
): Promise<void> {
  await runBusy(store, "admin:accounts:create", async () => {
    await api(endpoints.createUser.path(), {
      method: "POST",
      body: JSON.stringify(body),
    });
    onSuccess?.();
    await loadUsers(store);
    toast(t("admin.toast.accountCreated"), { type: "ok", title: t("admin.toast.complete") });
  });
}

/** Update an account with PUT /api/users/{id} (not PATCH). */
export async function updateAccount(
  store: AppStore,
  userId: Id,
  username: string,
  body: UpdateUserRequest,
  onSuccess?: () => void,
): Promise<void> {
  await runBusy(store, `admin:accounts:update:${userId}`, async () => {
    await api(endpoints.updateUser.path(userId), {
      method: "PUT",
      body: JSON.stringify(body),
    });
    onSuccess?.();
    await loadUsers(store);
    toast(t("admin.toast.accountUpdated", { username }), { type: "ok", title: t("admin.toast.complete") });
  });
}

export async function impersonateAccount(store: AppStore, userId: Id): Promise<void> {
  await runBusy(store, `admin:accounts:impersonate:${userId}`, async () => {
    const result = await api<ImpersonateUserResponse>(endpoints.impersonateUser.path(userId), {
      method: "POST",
      body: EMPTY_BODY,
    });
    // The server cookie now belongs to another account. Cancel every request
    // and atomically clear the outgoing account before hydrating the new one.
    resetSession(store, { preservePendingOperations: true });
    store.dispatch({ type: "SET_USER", payload: result.user });
    await loadInitial(store);
    store.dispatch({ type: "SET_ACTIVE_VIEW", payload: store.getState().activeView });
    toast(t("admin.toast.impersonated", { name: result.user.display_name || result.user.username }), { type: "ok", title: t("admin.toast.complete") });
  });
}

/* ============================================================ token usage */

/** Set tokenUsageDays first, then refetch; loadTokenUsage reads the new value. */
export async function changeTokenUsageDays(store: AppStore, days: number): Promise<void> {
  store.dispatch({ type: "SET_TOKEN_USAGE_DAYS", payload: Number(days) || 30 });
  await runBusy(store, "admin:tokens:range", () => loadTokenUsage(store));
}

/** Refresh token usage under the shared busy state. */
export async function refreshTokenUsage(store: AppStore): Promise<void> {
  await runBusy(store, "admin:tokens:refresh", () => loadTokenUsage(store));
}

/* =============================================================== paging */

/** Set the active page, then lazily load messages or tokens when selected. */
export async function selectAdminPage(store: AppStore, pageId: AdminPageId): Promise<void> {
  store.dispatch({ type: "SET_ACTIVE_ADMIN_PAGE", payload: pageId });
  await ensureAdminPageResource(store, pageId);
}

/* ========================================================== audit: select */

/** Select the channel used by message audit. */
export async function selectAuditChannel(store: AppStore, channelId: string): Promise<void> {
  store.dispatch({ type: "PATCH_MESSAGE_AUDIT", payload: { auditChannelId: channelId } });
  await runBusy(store, `admin:audit:channel:${channelId}`, () => loadAuditChannelMessages(store, channelId));
}

/** Select a private conversation for audit. */
export async function selectAuditConversation(store: AppStore, userId: Id): Promise<void> {
  store.dispatch({ type: "PATCH_MESSAGE_AUDIT", payload: { auditPrivateUserId: String(userId) } });
  await runBusy(store, `admin:audit:private:${userId}`, () => loadAuditPrivateMessages(store, userId));
}

/** Refresh one audited channel. */
export async function refreshAuditChannel(store: AppStore, channelId: string): Promise<void> {
  await runBusy(store, `admin:audit:channel:${channelId}`, () => loadAuditChannelMessages(store, channelId));
}

/** Refresh private-message audit data. */
export async function refreshMessageAudit(store: AppStore): Promise<void> {
  await runBusy(store, "admin:audit:refresh", () => loadMessageAudit(store));
}

/* ===================================================== audit: cascade reloads */

/** Refresh the channel list, audit list and active channel after an audit change. */
async function reloadAfterChannelAuditChange(store: AppStore, channelId: Id): Promise<void> {
  await Promise.all([loadChannels(store), loadAuditChannelMessages(store, channelId)]);
  if (String(store.getState().activeChannelId || "") === String(channelId)) {
    await loadChannelMessages(store);
  }
}

/** Refresh conversations, the audit list and the user's own private thread. */
async function reloadAfterPrivateAuditChange(store: AppStore, userId: Id): Promise<void> {
  await Promise.all([loadPrivateConversations(store), loadAuditPrivateMessages(store, userId)]);
  if (String(store.getState().user?.id || "") === String(userId)) {
    await loadPrivateMessages(store);
  }
}

/* ===================================================== audit: channel deletes */

/** Delete one channel message with the API's literal empty JSON body. */
export async function deleteChannelMessage(
  store: AppStore,
  channelId: Id,
  messageId: Id,
): Promise<void> {
  if (!channelId || !messageId) return;
  await runBusy(store, `admin:audit:delete-channel:${messageId}`, async () => {
    const result = await api<DeleteResultResponse>(
      endpoints.deleteChannelMessage.path(channelId, messageId),
      { method: "DELETE", body: EMPTY_BODY },
    );
    await reloadAfterChannelAuditChange(store, channelId);
    toast(t("admin.toast.channelDeleted", { count: result.deleted || 0 }), { type: "ok", title: t("admin.toast.complete") });
  });
}

/** Delete channel messages before one message id. */
export async function deleteChannelMessagesBefore(
  store: AppStore,
  channelId: Id,
  beforeCreatedAt: number,
): Promise<void> {
  if (!channelId || !beforeCreatedAt) return;
  await runBusy(store, `admin:audit:trim-channel:${channelId}`, async () => {
    const body: DeleteBeforeRequest = { before_created_at: beforeCreatedAt };
    const result = await api<DeleteResultResponse>(endpoints.deleteChannelMessages.path(channelId), {
      method: "DELETE",
      body: JSON.stringify(body),
    });
    await reloadAfterChannelAuditChange(store, channelId);
    toast(t("admin.toast.channelDeleted", { count: result.deleted || 0 }), { type: "ok", title: t("admin.toast.complete") });
  });
}

/** Clear all messages in one channel. */
export async function clearChannelMessages(store: AppStore, channelId: Id): Promise<void> {
  if (!channelId) return;
  await runBusy(store, `admin:audit:clear-channel:${channelId}`, async () => {
    const body: DeleteClearAllRequest = { clear_all: true };
    const result = await api<DeleteResultResponse>(endpoints.deleteChannelMessages.path(channelId), {
      method: "DELETE",
      body: JSON.stringify(body),
    });
    await reloadAfterChannelAuditChange(store, channelId);
    toast(t("admin.toast.channelCleared", { count: result.deleted || 0 }), { type: "ok", title: t("admin.toast.complete") });
  });
}

/* ===================================================== audit: private deletes */

/** Delete one private message with the API's literal empty JSON body. */
export async function deletePrivateMessage(
  store: AppStore,
  userId: Id,
  messageId: Id,
): Promise<void> {
  if (!userId || !messageId) return;
  await runBusy(store, `admin:audit:delete-private:${messageId}`, async () => {
    const result = await api<DeleteResultResponse>(
      endpoints.deletePrivateMessage.path(userId, messageId),
      { method: "DELETE", body: EMPTY_BODY },
    );
    await reloadAfterPrivateAuditChange(store, userId);
    toast(t("admin.toast.privateDeleted", { count: result.deleted || 0 }), { type: "ok", title: t("admin.toast.complete") });
  });
}

/** Delete private messages before one message id. */
export async function deletePrivateMessagesBefore(
  store: AppStore,
  userId: Id,
  beforeCreatedAt: number,
): Promise<void> {
  if (!userId || !beforeCreatedAt) return;
  await runBusy(store, `admin:audit:trim-private:${userId}`, async () => {
    const body: DeleteBeforeRequest = { before_created_at: beforeCreatedAt };
    const result = await api<DeleteResultResponse>(endpoints.deletePrivateMessages.path(userId), {
      method: "DELETE",
      body: JSON.stringify(body),
    });
    await reloadAfterPrivateAuditChange(store, userId);
    toast(t("admin.toast.privateDeleted", { count: result.deleted || 0 }), { type: "ok", title: t("admin.toast.complete") });
  });
}

/** Clear a private conversation. */
export async function clearPrivateMessages(store: AppStore, userId: Id): Promise<void> {
  if (!userId) return;
  await runBusy(store, `admin:audit:clear-private:${userId}`, async () => {
    const body: DeleteClearAllRequest = { clear_all: true };
    const result = await api<DeleteResultResponse>(endpoints.deletePrivateMessages.path(userId), {
      method: "DELETE",
      body: JSON.stringify(body),
    });
    await reloadAfterPrivateAuditChange(store, userId);
    toast(t("admin.toast.privateCleared", { count: result.deleted || 0 }), { type: "ok", title: t("admin.toast.complete") });
  });
}

/* ============================================================= config: PUTs

   Configuration writes use the declared endpoint, method and body; numbers are
   carried as strings, empty
   secrets dropped (callers send "" which the backend treats as "keep"), and the
   exact per-page refetch scope + toast. `onSuccess`
   runs only after a successful PUT (inside runBusy) and is used by the form to
   clear secret inputs. */

/** The PUT response replaces securityConfig without a GET refetch; restart flags drive
 *  the toast message + title. */
export async function saveSecurityConfig(
  store: AppStore,
  body: SecurityConfigUpdateRequest,
  onSuccess?: () => void,
): Promise<void> {
  await runBusy(store, "admin:security:save", async () => {
    const result = await api<SecurityConfigResponse>(endpoints.updateSecurityConfig.path(), {
      method: "PUT",
      body: JSON.stringify(body),
    });
    store.dispatch({ type: "SET_SECURITY_CONFIG", payload: result });
    onSuccess?.();
    const needsRestart = !!result.restart_required;
    const secretRestart = !!result.session_secret_restart_required;
    toast(
      secretRestart
        ? t("admin.toast.securitySecretRestart")
        : needsRestart
          ? t("admin.toast.securityRestart")
          : t("admin.toast.securitySaved"),
      { type: "ok", title: t(needsRestart || secretRestart ? "admin.toast.restartRequired" : "admin.toast.complete") },
    );
  });
}

/** Save the platform-owned Agent runtime settings, then refresh all dependent
 * runtime and model state. */
export async function saveAgentRuntimeConfig(
  store: AppStore,
  body: AgentRuntimeConfigUpdateRequest,
  onSuccess?: () => void,
): Promise<void> {
  await runBusy(store, "admin:agent-runtime:save", async () => {
    await api(endpoints.updateAgentRuntimeConfig.path(), { method: "PUT", body: JSON.stringify(body) });
    onSuccess?.();
    await loadSettings(store);
    toast(t("admin.toast.agentRuntimeSaved"), { type: "ok", title: t("admin.toast.complete") });
  });
}

/** Save and reload only Telegram configuration. */
export async function saveTelegramConfig(
  store: AppStore,
  body: TelegramConfigUpdateRequest,
  onSuccess?: () => void,
): Promise<void> {
  await runBusy(store, "admin:telegram:save", async () => {
    await api(endpoints.updateTelegramConfig.path(), { method: "PUT", body: JSON.stringify(body) });
    onSuccess?.();
    await loadTelegramConfig(store);
    toast(t("admin.toast.telegramSaved"), { type: "ok", title: t("admin.toast.complete") });
  });
}

/** Save and reload only automatic-update configuration. */
export async function saveAutoUpdateConfig(
  store: AppStore,
  body: AutoUpdateConfigUpdateRequest,
  onSuccess?: () => void,
): Promise<void> {
  await runBusy(store, "admin:updates:save", async () => {
    await api(endpoints.updateAutoUpdateConfig.path(), {
      method: "PUT",
      body: JSON.stringify(body),
    });
    onSuccess?.();
    await loadAutoUpdateConfig(store);
    toast(t("admin.toast.autoUpdateSaved"), { type: "ok", title: t("admin.toast.complete") });
  });
}

async function runBrandingMutation(
  store: AppStore,
  operationId: string,
  request: () => Promise<BrandingSnapshot>,
  onApplied: (snapshot: BrandingSnapshot) => void,
): Promise<void> {
  await runBusy(store, operationId, async () => {
    try {
      const result = await request();
      store.dispatch({ type: "SET_BRANDING_CONFIG", payload: result });
      onApplied(result);
      toast(t("admin.toast.brandingSaved"), { type: "ok", title: t("admin.toast.complete") });
    } catch (error) {
      await loadBrandingConfig(store).then(() => {
        const current = store.getState().brandingConfig;
        if (current) onApplied(current);
      }).catch(() => undefined);
      throw error;
    }
  });
}

export function saveBrandingConfig(
  store: AppStore,
  body: BrandingConfigUpdateRequest,
  onApplied: (snapshot: BrandingSnapshot) => void,
): Promise<void> {
  return runBrandingMutation(
    store,
    "admin:branding:save",
    () => api<BrandingSnapshot>(endpoints.updateBrandingConfig.path(), {
      method: "PUT",
      body: JSON.stringify(body),
    }),
    onApplied,
  );
}

export function saveBrandingLogo(
  store: AppStore,
  body: BrandingLogoUpdateRequest,
  onApplied: (snapshot: BrandingSnapshot) => void,
): Promise<void> {
  return runBrandingMutation(
    store,
    "admin:branding:logo:save",
    () => api<BrandingSnapshot>(endpoints.updateBrandingLogo.path(), {
      method: "PUT",
      body: JSON.stringify(body),
    }),
    onApplied,
  );
}

export function deleteBrandingLogo(
  store: AppStore,
  body: BrandingLogoDeleteRequest,
  onApplied: (snapshot: BrandingSnapshot) => void,
): Promise<void> {
  return runBrandingMutation(
    store,
    "admin:branding:logo:delete",
    () => api<BrandingSnapshot>(endpoints.deleteBrandingLogo.path(), {
      method: "DELETE",
      body: JSON.stringify(body),
    }),
    onApplied,
  );
}

/** Save the Manager-owned, hot-reloaded LAN listener configuration. */
export async function saveLANAccessConfig(
  store: AppStore,
  body: Pick<
    AutoUpdateConfigUpdateRequest,
    "lan_enabled" | "lan_listen" | "direct_access_cidrs" | "trusted_ingress_cidrs"
  >,
): Promise<void> {
  await runBusy(store, "admin:security:lan:save", async () => {
    try {
      await api(endpoints.updateAutoUpdateConfig.path(), {
        method: "PUT",
        body: JSON.stringify(body),
      });
    } finally {
      // A rejected bind leaves the previous listener active and records a
      // bounded Manager error; refresh even on failure so the UI shows that
      // real applied state instead of the optimistic form values.
      await loadAutoUpdateConfig(store);
    }
    toast(t("admin.toast.lanSaved"), { type: "ok", title: t("admin.toast.complete") });
  });
}

/** Request an immediate update check with a literal empty JSON body. */
export async function checkAutoUpdateNow(store: AppStore): Promise<void> {
  await runBusy(store, "admin:updates:check", async () => {
    await api(endpoints.autoUpdateCheck.path(), { method: "POST", body: EMPTY_BODY });
    await loadAutoUpdateConfig(store);
    toast(t("admin.toast.autoUpdateCheck"), { type: "ok", title: t("admin.toast.sent") });
  });
}

export async function runManagerOperation(
  store: AppStore,
  operation: Exclude<ManagerOperation, "install">,
  expectedGeneration: number,
): Promise<void> {
  await runBusy(store, `admin:updates:${operation}`, async () => {
    await api(endpoints.managerOperation.path(operation), {
      method: "POST",
      body: JSON.stringify({ expected_generation: expectedGeneration }),
    });
    await loadAutoUpdateConfig(store);
    toast(t("admin.toast.autoUpdateCheck"), { type: "ok", title: t("admin.toast.sent") });
  });
}

/** Validate and save the external embeddings configuration, then refresh index state. */
export async function saveKnowledgeConfig(
  store: AppStore,
  body: KnowledgeConfigUpdateRequest,
): Promise<void> {
  await runBusy(store, "admin:knowledge:save", async () => {
    await api(endpoints.updateKnowledgeConfig.path(), {
      method: "PUT",
      body: JSON.stringify(body),
    });
    await loadKnowledgeAdmin(store);
    toast(t("admin.toast.knowledgeSaved"), { type: "ok", title: t("admin.toast.complete") });
  });
}

/** Rebuild a shadow knowledge generation from the authoritative documents. */
export async function reindexKnowledge(store: AppStore): Promise<void> {
  await runBusy(store, "admin:knowledge:reindex", async () => {
    await api(endpoints.reindexKnowledge.path(), {
      method: "POST",
      body: EMPTY_BODY,
    });
    await loadKnowledgeStatus(store);
    toast(t("admin.toast.knowledgeReindexQueued"), {
      type: "ok",
      title: t("admin.toast.sent"),
    });
  });
}

/* =============================================================== secrets */

/** Set one secret with body { value }; an empty value is still posted. On success,
 *  clear the input (onSuccess) + reload ONLY secrets. NOTE: the key is
 *  interpolated into the path verbatim by API contract (no encodeURIComponent). */
export async function setSecret(
  store: AppStore,
  key: string,
  value: string,
  onSuccess?: () => void,
): Promise<void> {
  await runBusy(store, `admin:secrets:set:${key}`, async () => {
    await api(endpoints.setSecret.path(key), { method: "PUT", body: JSON.stringify({ value }) });
    onSuccess?.();
    await loadSecrets(store);
    toast(t("admin.toast.secretUpdated", { key }), { type: "ok", title: t("admin.toast.complete") });
  });
}

/* =============================================================== oauth flows

   Every action routes through runBusy and updateOAuthState (the
   SET_OAUTH_STATE reducer case) and reloads the Agent runtime config. The
   start/check bodies are the literal "{}" / { flow_id }. No
   auto-poll exists — poll/complete are user-triggered. */

/** Merge a provider verification response into OAuth state. */
function updateOAuthState(
  store: AppStore,
  providerId: string,
  result: OAuthFlowResponse,
): void {
  store.dispatch({
    type: "SET_OAUTH_STATE",
    payload: {
      providerId,
      providers: result.providers || [],
      activeProvider: result.active_provider,
      flow: result.flow ?? null,
    },
  });
}

export async function startOAuthVerification(store: AppStore, providerId: string): Promise<void> {
  await runBusy(store, `admin:oauth:start:${providerId}`, async () => {
    const result = await api<OAuthFlowResponse>(endpoints.startOAuth.path(providerId), {
      method: "POST",
      body: EMPTY_BODY,
    });
    updateOAuthState(store, providerId, result);
    await loadAgentRuntimeConfig(store);
  });
}

export async function pollOAuthVerification(
  store: AppStore,
  providerId: string,
  flowId: string,
): Promise<void> {
  await runBusy(store, `admin:oauth:poll:${providerId}`, async () => {
    const result = await api<OAuthFlowResponse>(endpoints.pollOAuth.path(providerId), {
      method: "POST",
      body: JSON.stringify({ flow_id: flowId }),
    });
    updateOAuthState(store, providerId, result);
    await loadAgentRuntimeConfig(store);
  });
}

export async function completeOAuthVerification(
  store: AppStore,
  providerId: string,
  flowId: string,
): Promise<void> {
  await runBusy(store, `admin:oauth:complete:${providerId}`, async () => {
    const callbackUrl = store.getState().oauthCallbackUrls[providerId] || "";
    const result = await api<OAuthFlowResponse>(endpoints.completeOAuth.path(providerId), {
      method: "POST",
      body: JSON.stringify({ flow_id: flowId, callback_url: callbackUrl }),
    });
    updateOAuthState(store, providerId, result);
    if (result.flow?.complete) {
      store.dispatch({ type: "SET_OAUTH_CALLBACK_URL", payload: { providerId, value: "" } });
    }
    await loadAgentRuntimeConfig(store);
  });
}

/** Write the in-progress Grok callback URL. */
export function setOAuthCallbackUrl(store: AppStore, providerId: string, value: string): void {
  store.dispatch({ type: "SET_OAUTH_CALLBACK_URL", payload: { providerId, value } });
}

/** Export OAuth credentials with GET to a client-side JSON download. */
export async function exportOAuthCredentials(store: AppStore): Promise<void> {
  await runBusy(store, "admin:oauth:export", async () => {
    const payload = await api(endpoints.exportOAuthCredentials.path());
    downloadJson(payload, `agent-oauth-credentials-${new Date().toISOString().slice(0, 10)}.json`);
    toast(t("admin.toast.oauthExported"), { type: "ok", title: t("admin.toast.complete") });
  });
}

/** Import OAuth credentials, then reload secrets and runtime model state. */
export async function importOAuthCredentials(store: AppStore, file: File): Promise<void> {
  await runBusy(store, "admin:oauth:import", async () => {
    let credentials: unknown;
    try {
      credentials = JSON.parse(await file.text());
    } catch {
      throw new Error(t("admin.toast.oauthInvalidJson"));
    }
    const result = await api<OAuthImportResponse>(endpoints.importOAuthCredentials.path(), {
      method: "POST",
      body: JSON.stringify({ credentials }),
    });
    updateOAuthState(store, result.active_provider || "", result);
    await Promise.all([loadSecrets(store), loadAgentRuntimeConfig(store)]);
    const count = result.imported?.keys?.length || 0;
    toast(t("admin.toast.oauthImported", { count }), { type: "ok", title: t("admin.toast.complete") });
  });
}
