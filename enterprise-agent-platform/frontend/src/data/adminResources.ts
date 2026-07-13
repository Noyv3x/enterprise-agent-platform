/* Page-scoped administration reads. Entering the admin area loads only the
   active page; completed reads stay cached for the current signed-in session. */

import type { AdminPageId, AppState } from "../types";
import { ensureResource, resourceKeys, runResourceLoad } from "./resourceState";
import {
  loadAutoUpdateConfig,
  loadCogneeConfig,
  loadHermesConfig,
  loadHermesInternalConfig,
  loadMessageAudit,
  loadOAuthProviders,
  loadPermissionGroups,
  loadRuntime,
  loadSecrets,
  loadSecurityConfig,
  loadTelegramConfig,
  loadTokenUsage,
  loadUsers,
  type AppStore,
} from "./loaders";

export function loadAdminPage(store: AppStore, pageId: AdminPageId): Promise<void> {
  switch (pageId) {
    case "accounts":
      return Promise.all([loadUsers(store), loadPermissionGroups(store)]).then(() => undefined);
    case "tokens":
      return loadTokenUsage(store);
    case "messages":
      return loadMessageAudit(store);
    case "model":
      return Promise.all([loadOAuthProviders(store), loadHermesConfig(store)]).then(() => undefined);
    case "telegram":
      return loadTelegramConfig(store);
    case "updates":
      return loadAutoUpdateConfig(store);
    case "security":
      return loadSecurityConfig(store);
    case "runtime":
      return loadRuntime(store);
    case "hermes":
      return loadHermesInternalConfig(store);
    case "cognee":
      return loadCogneeConfig(store);
    case "secrets":
      return loadSecrets(store);
  }
}

export function ensureAdminPageResource(store: AppStore, pageId: AdminPageId): Promise<boolean> {
  return ensureResource(store, resourceKeys.admin(pageId), () => loadAdminPage(store, pageId));
}

export function refreshAdminPageResource(store: AppStore, pageId: AdminPageId): Promise<boolean> {
  return runResourceLoad(store, resourceKeys.admin(pageId), () => loadAdminPage(store, pageId));
}

/** Whether an in-memory page payload exists before resource metadata is taken
 * into account. A successful empty response is represented by updatedAt. */
export function hasAdminPageData(state: AppState, pageId: AdminPageId): boolean {
  switch (pageId) {
    case "accounts":
      return state.users.length > 0 || state.permissionGroups.length > 0;
    case "tokens":
      return state.tokenUsage !== null;
    case "messages":
      return !!(
        state.messageAudit.channelMessages.length ||
        state.messageAudit.privateConversations.length ||
        state.messageAudit.privateMessages.length
      );
    case "model":
      return state.oauthProviders !== null || state.hermesConfig !== null;
    case "telegram":
      return state.telegramConfig !== null;
    case "updates":
      return state.autoUpdateConfig !== null;
    case "security":
      return state.securityConfig !== null;
    case "runtime":
      return state.runtimes !== null;
    case "hermes":
      return state.hermesInternalConfig !== null;
    case "cognee":
      return state.cogneeConfig !== null;
    case "secrets":
      return state.secrets.length > 0;
  }
}
