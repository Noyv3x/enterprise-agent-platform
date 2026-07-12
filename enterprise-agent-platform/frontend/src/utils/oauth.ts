/* =====================================================================
   OAuth-specific pure helpers — ported from legacy-app.js:2740-2746,
   2803-2806, 1787-1790.
   ===================================================================== */

import { t } from "../i18n";
import type { OAuthProvider } from "../types";

/** Secrets whose key contains "_OAUTH_" are managed by the OAuth card, not the
 *  manual secrets list (legacy-app.js:2803). */
export function isOAuthSecret(key: string): boolean {
  return key.includes("_OAUTH_");
}

const OAUTH_STATUS_KEYS = {
  waiting_for_user: "oauth.waitingForUser",
  waiting_for_callback: "oauth.waitingForCallback",
  complete: "oauth.complete",
} as const;

export function oauthStatusLabel(status: string | null | undefined): string {
  const key = status ? OAUTH_STATUS_KEYS[status as keyof typeof OAUTH_STATUS_KEYS] : undefined;
  return key ? t(key) : status || t("oauth.waiting");
}

/** Human error string derived from provider.last_auth_error. */
export function oauthProviderErrorText(provider: OAuthProvider | null | undefined): string {
  const authError = provider?.last_auth_error;
  if (!authError || typeof authError !== "object") return "";
  const message = String(authError.message || authError.detail || authError.code || "").trim();
  if (!message) return "";
  return authError.relogin_required ? t("oauth.reloginRequired", { message }) : message;
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
