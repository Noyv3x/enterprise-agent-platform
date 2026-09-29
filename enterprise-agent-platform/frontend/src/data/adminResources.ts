/* Page-scoped administration reads. Entering the admin area loads only the
   active page; completed reads stay cached for the current signed-in session. */

import type { AdminPageId } from "../types";
import { ensureResource, resourceKeys, runResourceLoad } from "./resourceState";
import {
  loadAutoUpdateConfig,
  loadBrandingConfig,
  loadAgentRuntimeConfig,
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
      return Promise.all([
        loadUsers(store),
        loadPermissionGroups(store),
        loadOAuthProviders(store),
        loadAgentRuntimeConfig(store),
      ]).then(() => undefined);
    case "tokens":
      return loadTokenUsage(store);
    case "messages":
      return loadMessageAudit(store);
    case "agent-runtime":
      return Promise.all([loadOAuthProviders(store), loadAgentRuntimeConfig(store)]).then(() => undefined);
    case "telegram":
      return loadTelegramConfig(store);
    case "updates":
      return loadAutoUpdateConfig(store);
    case "branding":
      return loadBrandingConfig(store);
    case "security":
      return Promise.all([loadSecurityConfig(store), loadAutoUpdateConfig(store)]).then(() => undefined);
    case "runtime":
      return loadRuntime(store);
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

