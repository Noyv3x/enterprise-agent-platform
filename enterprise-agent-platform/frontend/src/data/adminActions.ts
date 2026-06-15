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
  loadAutoUpdateConfig,
  loadChannelMessages,
  loadChannels,
  loadCogneeConfig,
  loadHermesConfig,
  loadHermesInternalConfig,
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
import { runBusy } from "./sessionActions";
import type {
  AdminPageId,
  AutoUpdateConfigUpdateRequest,
  CreateUserRequest,
  DeleteBeforeRequest,
  DeleteClearAllRequest,
  DeleteResultResponse,
  HermesConfigUpdateRequest,
  Id,
  OAuthFlowResponse,
  OAuthImportResponse,
  SecurityConfigResponse,
  SecurityConfigUpdateRequest,
  TelegramConfigUpdateRequest,
  UpdateUserRequest,
} from "../types";

/* =============================================================== accounts */

/** Create an enterprise account (legacy renderAccountManagement onsubmit,
 *  legacy-app.js:1438-1458). POST /api/users. `onSuccess` resets the form
 *  fields and runs inside runBusy so it only fires on a successful POST. */
export async function createAccount(
  store: AppStore,
  body: CreateUserRequest,
  onSuccess?: () => void,
): Promise<void> {
  await runBusy(store, async () => {
    await api(endpoints.createUser.path(), {
      method: "POST",
      body: JSON.stringify(body),
    });
    onSuccess?.();
    await loadUsers(store);
    toast("企业账户已创建", { type: "ok", title: "完成" });
  });
}

/** Update an enterprise account (legacy renderAccountRow onsubmit,
 *  legacy-app.js:1496-1514). PUT /api/users/{id} (NOT PATCH). */
export async function updateAccount(
  store: AppStore,
  userId: Id,
  username: string,
  body: UpdateUserRequest,
  onSuccess?: () => void,
): Promise<void> {
  await runBusy(store, async () => {
    await api(endpoints.updateUser.path(userId), {
      method: "PUT",
      body: JSON.stringify(body),
    });
    onSuccess?.();
    await loadUsers(store);
    toast(`已更新 ${username}`, { type: "ok", title: "完成" });
  });
}

/* ============================================================ token usage */

/** Days-range change (legacy days select onchange, legacy-app.js:1566-1568):
 *  set tokenUsageDays first, then refetch (loadTokenUsage reads it). */
export async function changeTokenUsageDays(store: AppStore, days: number): Promise<void> {
  store.dispatch({ type: "SET_TOKEN_USAGE_DAYS", payload: Number(days) || 30 });
  await runBusy(store, () => loadTokenUsage(store));
}

/** Manual refresh button (legacy onclick withBusy(loadTokenUsage)). */
export async function refreshTokenUsage(store: AppStore): Promise<void> {
  await runBusy(store, () => loadTokenUsage(store));
}

/* =============================================================== paging */

/** Pager tab switch (legacy renderAdminPager onclick, legacy-app.js:1374-1378):
 *  set the active page, then lazily load messages/tokens on each click. */
export async function selectAdminPage(store: AppStore, pageId: AdminPageId): Promise<void> {
  store.dispatch({ type: "SET_ACTIVE_ADMIN_PAGE", payload: pageId });
  if (pageId === "messages") await runBusy(store, () => loadMessageAudit(store));
  else if (pageId === "tokens") await runBusy(store, () => loadTokenUsage(store));
}

/* ========================================================== audit: select */

/** Channel select change (legacy channelSelect onchange, legacy-app.js:1798-1801). */
export async function selectAuditChannel(store: AppStore, channelId: string): Promise<void> {
  store.dispatch({ type: "PATCH_MESSAGE_AUDIT", payload: { auditChannelId: channelId } });
  await runBusy(store, () => loadAuditChannelMessages(store, channelId));
}

/** Conversation select (legacy renderPrivateConversationItem onclick, :1952-1954). */
export async function selectAuditConversation(store: AppStore, userId: Id): Promise<void> {
  store.dispatch({ type: "PATCH_MESSAGE_AUDIT", payload: { auditPrivateUserId: String(userId) } });
  await runBusy(store, () => loadAuditPrivateMessages(store, userId));
}

/** Channel-card refresh button (legacy onclick withBusy(loadAuditChannelMessages)). */
export async function refreshAuditChannel(store: AppStore, channelId: string): Promise<void> {
  await runBusy(store, () => loadAuditChannelMessages(store, channelId));
}

/** Private-card refresh button (legacy onclick withBusy(loadMessageAudit)). */
export async function refreshMessageAudit(store: AppStore): Promise<void> {
  await runBusy(store, () => loadMessageAudit(store));
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
  await runBusy(store, async () => {
    const result = await api<DeleteResultResponse>(
      endpoints.deleteChannelMessage.path(channelId, messageId),
      { method: "DELETE", body: EMPTY_BODY },
    );
    await reloadAfterChannelAuditChange(store, channelId);
    toast(`已删除 ${result.deleted || 0} 条频道消息`, { type: "ok", title: "完成" });
  });
}

/** legacy deleteChannelMessagesBefore (legacy-app.js:3075-3086). */
export async function deleteChannelMessagesBefore(
  store: AppStore,
  channelId: Id,
  beforeCreatedAt: number,
): Promise<void> {
  if (!channelId || !beforeCreatedAt) return;
  await runBusy(store, async () => {
    const body: DeleteBeforeRequest = { before_created_at: beforeCreatedAt };
    const result = await api<DeleteResultResponse>(endpoints.deleteChannelMessages.path(channelId), {
      method: "DELETE",
      body: JSON.stringify(body),
    });
    await reloadAfterChannelAuditChange(store, channelId);
    toast(`已删除 ${result.deleted || 0} 条频道消息`, { type: "ok", title: "完成" });
  });
}

/** legacy clearChannelMessages (legacy-app.js:3088-3099). */
export async function clearChannelMessages(store: AppStore, channelId: Id): Promise<void> {
  if (!channelId) return;
  await runBusy(store, async () => {
    const body: DeleteClearAllRequest = { clear_all: true };
    const result = await api<DeleteResultResponse>(endpoints.deleteChannelMessages.path(channelId), {
      method: "DELETE",
      body: JSON.stringify(body),
    });
    await reloadAfterChannelAuditChange(store, channelId);
    toast(`已清空 ${result.deleted || 0} 条频道消息`, { type: "ok", title: "完成" });
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
  await runBusy(store, async () => {
    const result = await api<DeleteResultResponse>(
      endpoints.deletePrivateMessage.path(userId, messageId),
      { method: "DELETE", body: EMPTY_BODY },
    );
    await reloadAfterPrivateAuditChange(store, userId);
    toast(`已删除 ${result.deleted || 0} 条私人 Agent 消息`, { type: "ok", title: "完成" });
  });
}

/** legacy deletePrivateMessagesBefore (legacy-app.js:3111-3122). */
export async function deletePrivateMessagesBefore(
  store: AppStore,
  userId: Id,
  beforeCreatedAt: number,
): Promise<void> {
  if (!userId || !beforeCreatedAt) return;
  await runBusy(store, async () => {
    const body: DeleteBeforeRequest = { before_created_at: beforeCreatedAt };
    const result = await api<DeleteResultResponse>(endpoints.deletePrivateMessages.path(userId), {
      method: "DELETE",
      body: JSON.stringify(body),
    });
    await reloadAfterPrivateAuditChange(store, userId);
    toast(`已删除 ${result.deleted || 0} 条私人 Agent 消息`, { type: "ok", title: "完成" });
  });
}

/** legacy clearPrivateMessages (legacy-app.js:3124-3135). */
export async function clearPrivateMessages(store: AppStore, userId: Id): Promise<void> {
  if (!userId) return;
  await runBusy(store, async () => {
    const body: DeleteClearAllRequest = { clear_all: true };
    const result = await api<DeleteResultResponse>(endpoints.deletePrivateMessages.path(userId), {
      method: "DELETE",
      body: JSON.stringify(body),
    });
    await reloadAfterPrivateAuditChange(store, userId);
    toast(`已清空 ${result.deleted || 0} 条私人 Agent 消息`, { type: "ok", title: "完成" });
  });
}

/* ============================================================= config: PUTs

   Phase 4d additions. Each mirrors the legacy form onsubmit handler byte-for-
   byte: identical endpoint/method/body, numbers carried as STRINGS, empty
   secrets dropped (callers send "" which the backend treats as "keep"), and the
   exact per-page refetch scope + toast (spec-admin-config §12.5). `onSuccess`
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
  await runBusy(store, async () => {
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
        ? "已保存；重启后所有会话会失效"
        : needsRestart
          ? "已保存；部分启动项需要重启/重新部署后生效"
          : "公网安全配置已保存",
      { type: "ok", title: needsRestart || secretRestart ? "需要重启" : "完成" },
    );
  });
}

/** legacy renderHermesConfig onsubmit (legacy-app.js:2227-2248). Reloads ALL
 *  settings (loadSettings). */
export async function saveHermesConfig(
  store: AppStore,
  body: HermesConfigUpdateRequest,
  onSuccess?: () => void,
): Promise<void> {
  await runBusy(store, async () => {
    await api(endpoints.updateHermesConfig.path(), { method: "PUT", body: JSON.stringify(body) });
    onSuccess?.();
    await loadSettings(store);
    toast("Hermes 配置已保存", { type: "ok", title: "完成" });
  });
}

/** legacy renderTelegramAdminConfig onsubmit (legacy-app.js:2310-2327). Reloads
 *  ONLY telegram config. */
export async function saveTelegramConfig(
  store: AppStore,
  body: TelegramConfigUpdateRequest,
  onSuccess?: () => void,
): Promise<void> {
  await runBusy(store, async () => {
    await api(endpoints.updateTelegramConfig.path(), { method: "PUT", body: JSON.stringify(body) });
    onSuccess?.();
    await loadTelegramConfig(store);
    toast("Telegram 配置已保存", { type: "ok", title: "完成" });
  });
}

/** legacy renderAutoUpdateConfig onsubmit (legacy-app.js:2393-2409). Reloads
 *  ONLY auto-update config. */
export async function saveAutoUpdateConfig(
  store: AppStore,
  body: AutoUpdateConfigUpdateRequest,
  onSuccess?: () => void,
): Promise<void> {
  await runBusy(store, async () => {
    await api(endpoints.updateAutoUpdateConfig.path(), {
      method: "PUT",
      body: JSON.stringify(body),
    });
    onSuccess?.();
    await loadAutoUpdateConfig(store);
    toast("自动更新配置已保存", { type: "ok", title: "完成" });
  });
}

/** legacy "立即检查" button (legacy-app.js:2435-2440). POST literal "{}". */
export async function checkAutoUpdateNow(store: AppStore): Promise<void> {
  await runBusy(store, async () => {
    await api(endpoints.autoUpdateCheck.path(), { method: "POST", body: EMPTY_BODY });
    await loadAutoUpdateConfig(store);
    toast("已触发自动更新检查", { type: "ok", title: "已发送" });
  });
}

/* ====================================================== config: hermes internal

   Three mutually-exclusive write shapes to the SAME endpoint (spec §9); all then
   reload ONLY hermes/internal-config. The `updates` diff maps come from
   <ConfigForm>'s collectConfigUpdates. */

export async function saveHermesYamlFields(
  store: AppStore,
  updates: Record<string, string>,
): Promise<void> {
  await runBusy(store, async () => {
    await api(endpoints.updateHermesInternalConfig.path(), {
      method: "PUT",
      body: JSON.stringify({ yaml_updates: updates }),
    });
    await loadHermesInternalConfig(store);
    toast("Hermes 内部配置已保存", { type: "ok", title: "完成" });
  });
}

export async function saveHermesYamlText(store: AppStore, yamlText: string): Promise<void> {
  await runBusy(store, async () => {
    await api(endpoints.updateHermesInternalConfig.path(), {
      method: "PUT",
      body: JSON.stringify({ yaml_text: yamlText }),
    });
    await loadHermesInternalConfig(store);
    toast("Hermes config.yaml 已保存", { type: "ok", title: "完成" });
  });
}

export async function saveHermesEnv(
  store: AppStore,
  updates: Record<string, string>,
): Promise<void> {
  await runBusy(store, async () => {
    await api(endpoints.updateHermesInternalConfig.path(), {
      method: "PUT",
      body: JSON.stringify({ env: updates }),
    });
    await loadHermesInternalConfig(store);
    toast("Hermes .env 已保存", { type: "ok", title: "完成" });
  });
}

/** legacy renderCogneeInternalConfig onsubmit (legacy-app.js:2523-2529). Reloads
 *  cognee config AND runtime (env changes can affect Cognee health). */
export async function saveCogneeEnv(
  store: AppStore,
  updates: Record<string, string>,
): Promise<void> {
  await runBusy(store, async () => {
    await api(endpoints.updateCogneeConfig.path(), {
      method: "PUT",
      body: JSON.stringify({ env: updates }),
    });
    await loadCogneeConfig(store);
    await loadRuntime(store);
    toast("Cognee 内部配置已保存", { type: "ok", title: "完成" });
  });
}

/* =============================================================== runtime actions */

/** legacy runtime restart/refresh button (legacy-app.js:2114-2118). POST "{}",
 *  then reload ALL settings (same endpoint regardless of the button label). */
export async function restartRuntime(store: AppStore, name: string): Promise<void> {
  await runBusy(store, async () => {
    await api(endpoints.restartRuntime.path(name), { method: "POST", body: EMPTY_BODY });
    await loadSettings(store);
  });
}

/** legacy runHermesInstall (legacy-app.js:2130-2136). POST "{}", reload ALL. */
export async function installHermes(store: AppStore): Promise<void> {
  await runBusy(store, async () => {
    await api(endpoints.installHermes.path(), { method: "POST", body: EMPTY_BODY });
    await loadSettings(store);
    toast("已触发 Hermes 安装", { type: "ok", title: "完成" });
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
  await runBusy(store, async () => {
    await api(endpoints.setSecret.path(key), { method: "PUT", body: JSON.stringify({ value }) });
    onSuccess?.();
    await loadSecrets(store);
    toast(`已更新 ${key}`, { type: "ok", title: "完成" });
  });
}

/* =============================================================== oauth flows

   The verification state machine (spec-oauth-utils-data §2, legacy-app.js:
   3366-3428). Every action routes through runBusy + updateOAuthState (the
   SET_OAUTH_STATE reducer case) and reloads hermesConfig (verification switches
   Hermes). The start/check bodies are the literal "{}" / { flow_id }. No
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
  await runBusy(store, async () => {
    const result = await api<OAuthFlowResponse>(endpoints.startOAuth.path(providerId), {
      method: "POST",
      body: EMPTY_BODY,
    });
    updateOAuthState(store, providerId, result);
    await loadHermesConfig(store);
  });
}

export async function pollOAuthVerification(
  store: AppStore,
  providerId: string,
  flowId: string,
): Promise<void> {
  await runBusy(store, async () => {
    const result = await api<OAuthFlowResponse>(endpoints.pollOAuth.path(providerId), {
      method: "POST",
      body: JSON.stringify({ flow_id: flowId }),
    });
    updateOAuthState(store, providerId, result);
    await loadHermesConfig(store);
  });
}

export async function completeOAuthVerification(
  store: AppStore,
  providerId: string,
  flowId: string,
): Promise<void> {
  await runBusy(store, async () => {
    const callbackUrl = store.getState().oauthCallbackUrls[providerId] || "";
    const result = await api<OAuthFlowResponse>(endpoints.completeOAuth.path(providerId), {
      method: "POST",
      body: JSON.stringify({ flow_id: flowId, callback_url: callbackUrl }),
    });
    updateOAuthState(store, providerId, result);
    if (result.flow?.complete) {
      store.dispatch({ type: "SET_OAUTH_CALLBACK_URL", payload: { providerId, value: "" } });
    }
    await loadHermesConfig(store);
  });
}

/** Write the in-progress Grok callback URL (legacy textarea oninput). */
export function setOAuthCallbackUrl(store: AppStore, providerId: string, value: string): void {
  store.dispatch({ type: "SET_OAUTH_CALLBACK_URL", payload: { providerId, value } });
}

/** legacy exportOAuthCredentials (legacy-app.js:3391-3405). GET (no body) →
 *  client-side JSON download; no state change. */
export async function exportOAuthCredentials(store: AppStore): Promise<void> {
  await runBusy(store, async () => {
    const payload = await api(endpoints.exportOAuthCredentials.path());
    downloadJson(payload, `enterprise-oauth-credentials-${new Date().toISOString().slice(0, 10)}.json`);
    toast("OAuth 凭据文件已生成", { type: "ok", title: "完成" });
  });
}

/** legacy importOAuthCredentials (legacy-app.js:3407-3423). Parse the file JSON
 *  (throw the exact Chinese error on failure), POST { credentials }, then reload
 *  secrets + hermesConfig. */
export async function importOAuthCredentials(store: AppStore, file: File): Promise<void> {
  await runBusy(store, async () => {
    let credentials: unknown;
    try {
      credentials = JSON.parse(await file.text());
    } catch {
      throw new Error("OAuth 凭据文件不是有效 JSON");
    }
    const result = await api<OAuthImportResponse>(endpoints.importOAuthCredentials.path(), {
      method: "POST",
      body: JSON.stringify({ credentials }),
    });
    updateOAuthState(store, result.active_provider || "", result);
    await Promise.all([loadSecrets(store), loadHermesConfig(store)]);
    const count = result.imported?.keys?.length || 0;
    toast(`已导入 ${count} 个 OAuth 凭据`, { type: "ok", title: "完成" });
  });
}
