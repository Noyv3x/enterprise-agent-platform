/* <AdminPageBadge pageId/> — the per-tab count/string pill in the admin pager
   (legacy adminPageBadge, legacy-app.js:1388-1408). Returns null when the value
   is falsy (0 / "" / undefined → no badge). Reads many shared state slices, so
   it derives its value via a single selector returning a primitive (Object.is
   keeps the subscription cheap). */

import { formatCompactNumber } from "../../utils/format";
import { isOAuthSecret } from "../../utils/oauth";
import { useStore } from "../../store/useStore";
import type { AdminPageId, AppState } from "../../types";
import { useI18n } from "../../i18n";

export function adminPageBadgeValue(state: AppState, pageId: AdminPageId): number | string {
  const security = state.securityConfig?.config || {};
  const securityWarnings = [
    security.secure_cookie_enabled === false,
    security.admin_default_password_active,
    security.allow_default_admin_password,
    security.listen_restart_required,
  ].filter(Boolean).length;

  switch (pageId) {
    case "accounts":
      return state.users.length;
    case "tokens":
      return state.tokenUsage?.summary?.total_tokens
        ? formatCompactNumber(state.tokenUsage.summary.total_tokens)
        : 0;
    case "messages":
      return (state.messageAudit.privateConversations || []).filter(
        (item) => (item.message_count || 0) > 0,
      ).length;
    case "agent-runtime":
      return state.oauthProviders?.providers?.length || 0;
    case "telegram":
      return state.telegramConfig?.config?.enabled
        ? state.telegramConfig?.linked_users?.length || "enabled"
        : 0;
    case "updates":
      return state.autoUpdateConfig?.config?.enabled ? "enabled" : 0;
    case "security":
      return securityWarnings;
    case "runtime":
      return state.runtimes ? Object.keys(state.runtimes).length : 0;
    case "secrets":
      return state.secrets.filter((secret) => !isOAuthSecret(secret.key)).length;
    case "cognee":
      return 0;
  }
}

export function AdminPageBadge({ pageId }: { pageId: AdminPageId }) {
  const { t } = useI18n();
  const value = useStore((state) => adminPageBadgeValue(state, pageId));
  if (!value) return null;
  return (
    <span className="admin-pager__badge">
      {value === "enabled" ? t("admin.common.enabledShort") : String(value)}
    </span>
  );
}
