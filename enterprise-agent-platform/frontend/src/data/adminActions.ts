/* =====================================================================
   Admin data/actions — Phase 4c scope (accounts, token usage, message audit).

   Every action mirrors the legacy admin handlers byte-for-byte (payloads,
   endpoints, toasts, cascade reloads) and routes through runBusy (the withBusy
   port) so the global busy flag disables admin buttons app-wide exactly like the
   legacy double-render. The native window.confirm() prompts the legacy deletes
   used are NOT here — they are a render concern handled by the audit components
   via useConfirm(); these data-ops keep only the truthiness guards and assume
   confirmation already happened.

   Phase 4d ADDS the config/oauth/secrets actions to this same file — keep it
   cleanly extensible (one section per concern).
   ===================================================================== */

import { api, downloadJson } from "../lib/api";
import { EMPTY_BODY, endpoints } from "../lib/endpoints";
import { toast } from "../context/ToastContext";
import {
  loadAuditChannelMessages,
  loadAuditPrivateMessages,
  loadAgentRuntimeConfig,
  loadAutoUpdateConfig,
  loadChannelMessages,
  loadChannels,
  loadCogneeConfig,
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
  CreateUserRequest,
  DeleteBeforeRequest,
  DeleteClearAllRequest,
  DeleteResultResponse,
  AgentRuntimeConfigUpdateRequest,
  Id,
  ImpersonateUserResponse,
  OAuthFlowResponse,
  OAuthImportResponse,
  SecurityConfigResponse,
  SecurityConfigUpdateRequest,
  TelegramConfigUpdateRequest,
  UpdateUserRequest,
} from "../types";

const RUNTIME_RESTART_TIMEOUT_MS = 5 * 60_000;

/* =============================================================== accounts */

/** Create an account (legacy renderAccountManagement onsubmit,
 *  legacy-app.js:1438-1458). POST /api/users. `onSuccess` resets the form
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

/** Update an account (legacy renderAccountRow onsubmit,
 *  legacy-app.js:1496-1514). PUT /api/users/{id} (NOT PATCH). */
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

/** Days-range change (legacy days select onchange, legacy-app.js:1566-1568):
 *  set tokenUsageDays first, then refetch (loadTokenUsage reads it). */
export async function changeTokenUsageDays(store: AppStore, days: number): Promise<void> {
  store.dispatch({ type: "SET_TOKEN_USAGE_DAYS", payload: Number(days) || 30 });
  await runBusy(store, "admin:tokens:range", () => loadTokenUsage(store));
}

/** Manual refresh button (legacy onclick withBusy(loadTokenUsage)). */
export async function refreshTokenUsage(store: AppStore): Promise<void> {
  await runBusy(store, "admin:tokens:refresh", () => loadTokenUsage(store));
}

/* =============================================================== paging */

/** Pager tab switch (legacy renderAdminPager onclick, legacy-app.js:1374-1378):
 *  set the active page, then lazily load messages/tokens on each click. */
export async function selectAdminPage(store: AppStore, pageId: AdminPageId): Promise<void> {
  store.dispatch({ type: "SET_ACTIVE_ADMIN_PAGE", payload: pageId });
  await ensureAdminPageResource(store, pageId);
}

/* ========================================================== audit: select */

/** Channel select change (legacy channelSelect onchange, legacy-app.js:1798-1801). */
export async function selectAuditChannel(store: AppStore, channelId: string): Promise<void> {
  store.dispatch({ type: "PATCH_MESSAGE_AUDIT", payload: { auditChannelId: channelId } });
  await runBusy(store, `admin:audit:channel:${channelId}`, () => loadAuditChannelMessages(store, channelId));
}

/** Conversation select (legacy renderPrivateConversationItem onclick, :1952-1954). */
export async function selectAuditConversation(store: AppStore, userId: Id): Promise<void> {
  store.dispatch({ type: "PATCH_MESSAGE_AUDIT", payload: { auditPrivateUserId: String(userId) } });
  await runBusy(store, `admin:audit:private:${userId}`, () => loadAuditPrivateMessages(store, userId));
}

/** Channel-card refresh button (legacy onclick withBusy(loadAuditChannelMessages)). */
export async function refreshAuditChannel(store: AppStore, channelId: string): Promise<void> {
  await runBusy(store, `admin:audit:channel:${channelId}`, () => loadAuditChannelMessages(store, channelId));
}

/** Private-card refresh button (legacy onclick withBusy(loadMessageAudit)). */
export async function refreshMessageAudit(store: AppStore): Promise<void> {
  await runBusy(store, "admin:audit:refresh", () => loadMessageAudit(store));
}

/* ===================================================== audit: cascade reloads */

/** legacy reloadAfterChannelAuditChange (legacy-app.js:3137-3140): refresh the
 *  channel list + the audit list, and the LIVE channel view when it's active. */
async function reloadAfterChannelAuditChange(store: AppStore, channelId: Id): Promise<void> {
  await Promise.all([loadChannels(store), loadAuditChannelMessages(store, channelId)]);
  if (String(store.getState().activeChannelId || "") === String(channelId)) {
    await loadChannelMessages(store);
  }
}

/** legacy reloadAfterPrivateAuditChange (legacy-app.js:3142-3145): refresh the
 *  conversations + the audit list, and the user's own private thread if it's theirs. */
async function reloadAfterPrivateAuditChange(store: AppStore, userId: Id): Promise<void> {
  await Promise.all([loadPrivateConversations(store), loadAuditPrivateMessages(store, userId)]);
  if (String(store.getState().user?.id || "") === String(userId)) {
    await loadPrivateMessages(store);
  }
}

/* ===================================================== audit: channel deletes */

/** legacy deleteChannelMessage (legacy-app.js:3065-3073). DELETE body "{}". */
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

/** legacy deleteChannelMessagesBefore (legacy-app.js:3075-3086). */
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

/** legacy clearChannelMessages (legacy-app.js:3088-3099). */
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

/** legacy deletePrivateMessage (legacy-app.js:3101-3109). DELETE body "{}". */
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

/** legacy deletePrivateMessagesBefore (legacy-app.js:3111-3122). */
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

/** legacy clearPrivateMessages (legacy-app.js:3124-3135). */
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

   Phase 4d additions. Each mirrors the legacy form onsubmit handler byte-for-
   byte: identical endpoint/method/body, numbers carried as STRINGS, empty
   secrets dropped (callers send "" which the backend treats as "keep"), and the
   exact per-page refetch scope + toast. `onSuccess`
   runs only after a successful PUT (inside runBusy) and is used by the form to
   clear secret inputs. */

/** legacy renderSecuritySettings onsubmit (legacy-app.js:2023-2048). The PUT
 *  response REPLACES securityConfig (no GET refetch); the restart flags drive
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

/** legacy renderTelegramAdminConfig onsubmit (legacy-app.js:2310-2327). Reloads
 *  ONLY telegram config. */
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

/** legacy renderAutoUpdateConfig onsubmit (legacy-app.js:2393-2409). Reloads
 *  ONLY auto-update config. */
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

/** legacy "立即检查" button (legacy-app.js:2435-2440). POST literal "{}". */
export async function checkAutoUpdateNow(store: AppStore): Promise<void> {
  await runBusy(store, "admin:updates:check", async () => {
    await api(endpoints.autoUpdateCheck.path(), { method: "POST", body: EMPTY_BODY });
    await loadAutoUpdateConfig(store);
    toast(t("admin.toast.autoUpdateCheck"), { type: "ok", title: t("admin.toast.sent") });
  });
}

/** legacy renderCogneeInternalConfig onsubmit (legacy-app.js:2523-2529). Reloads
 *  cognee config AND runtime (env changes can affect Cognee health). */
export async function saveCogneeEnv(
  store: AppStore,
  updates: Record<string, string>,
): Promise<void> {
  await runBusy(store, "admin:cognee:save", async () => {
    await api(endpoints.updateCogneeConfig.path(), {
      method: "PUT",
      body: JSON.stringify({ env: updates }),
    });
    await loadCogneeConfig(store);
    await loadRuntime(store);
    toast(t("admin.toast.cogneeSaved"), { type: "ok", title: t("admin.toast.complete") });
  });
}

/* =============================================================== runtime actions */

/** legacy runtime restart/refresh button (legacy-app.js:2114-2118). POST "{}",
 *  then reload ALL settings (same endpoint regardless of the button label). */
export async function restartRuntime(store: AppStore, name: string): Promise<void> {
  await runBusy(store, `admin:runtime:restart:${name}`, async () => {
    await api(endpoints.restartRuntime.path(name), {
      method: "POST",
      body: EMPTY_BODY,
      timeoutMs: RUNTIME_RESTART_TIMEOUT_MS,
    });
    await loadSettings(store);
  });
}

/* =============================================================== secrets */

/** legacy renderSecretsSettings per-row onsubmit (legacy-app.js:2650-2657). PUT
 *  with body { value }; empty value still posts (backend treats it). On success
 *  clear the input (onSuccess) + reload ONLY secrets. NOTE: the key is
 *  interpolated into the path verbatim (no encodeURIComponent), preserving the
 *  legacy request byte-for-byte. */
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

   The verification state machine (legacy-app.js:3366-3428). Every action
   routes through runBusy + updateOAuthState (the
   SET_OAUTH_STATE reducer case) and reloads the Agent runtime config. The
   start/check bodies are the literal "{}" / { flow_id }. No
   auto-poll exists — poll/complete are user-triggered. */

/** Mirror of legacy updateOAuthState (legacy-app.js:3425-3428). */
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

/** Write the in-progress Grok callback URL (legacy textarea oninput). */
export function setOAuthCallbackUrl(store: AppStore, providerId: string, value: string): void {
  store.dispatch({ type: "SET_OAUTH_CALLBACK_URL", payload: { providerId, value } });
}

/** legacy exportOAuthCredentials (legacy-app.js:3391-3405). GET (no body) →
 *  client-side JSON download; no state change. */
export async function exportOAuthCredentials(store: AppStore): Promise<void> {
  await runBusy(store, "admin:oauth:export", async () => {
    const payload = await api(endpoints.exportOAuthCredentials.path());
    downloadJson(payload, `ubitech-agent-oauth-credentials-${new Date().toISOString().slice(0, 10)}.json`);
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
