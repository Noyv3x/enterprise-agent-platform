/* =====================================================================
   OAuth-specific pure helpers — ported from legacy-app.js:2740-2746,
   2803-2806, 1787-1790.
   ===================================================================== */

import type { OAuthProvider } from "../types";

/** Secrets whose key contains "_OAUTH_" are managed by the OAuth card, not the
 *  manual secrets list (legacy-app.js:2803). */
export function isOAuthSecret(key: string): boolean {
  return key.includes("_OAUTH_");
}

const OAUTH_STATUS_LABELS: Record<string, string> = {
  waiting_for_user: "等待网页登录",
  waiting_for_callback: "等待回调 URL",
  complete: "已完成",
};

export function oauthStatusLabel(status: string | null | undefined): string {
  return (status ? OAUTH_STATUS_LABELS[status] : undefined) || status || "等待中";
}

/** Human error string derived from provider.last_auth_error. */
export function oauthProviderErrorText(provider: OAuthProvider | null | undefined): string {
  const authError = provider?.last_auth_error;
  if (!authError || typeof authError !== "object") return "";
  const message = String(authError.message || authError.detail || authError.code || "").trim();
  if (!message) return "";
  return authError.relogin_required ? `需要重新验证：${message}` : message;
}

/** Label for a provider id, resolved against the loaded providers list
 *  (legacy-app.js:1787 read from global state; here the list is passed in). */
export function oauthProviderLabel(
  providerId: string,
  providers: OAuthProvider[] | null | undefined,
): string {
  const provider = (providers || []).find((item) => item.id === providerId);
  return provider?.label || providerId || "";
}
