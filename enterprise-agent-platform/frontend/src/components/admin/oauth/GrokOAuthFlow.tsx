import { Button, Field, Textarea } from "../../ui/beautiful";
import { completeOAuthVerification, setOAuthCallbackUrl } from "../../../data/adminActions";
import { useI18n } from "../../../i18n";
import { safeUrl } from "../../../lib/api";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { OAuthManualCallbackFlow } from "../../../types";
import { FormFooter, Notice } from "../../ui/beautiful";

export interface GrokOAuthFlowProps { providerId: string; flow: OAuthManualCallbackFlow; callbackValue: string }
export function GrokOAuthFlow({ providerId, flow, callbackValue }: GrokOAuthFlowProps) {
  const { t } = useI18n();
  const store = useStoreHandle();
  const verifying = useStore((state) => state.pendingOperations.includes(`admin:oauth:complete:${providerId}`));
  const busy = useStore((state) => state.pendingOperations.some((key) => key.startsWith("admin:oauth:") && key.endsWith(`:${providerId}`)));
  const status = flow.status === "waiting_for_callback" ? t("admin.oauth.waitingForCallback") : flow.status === "complete" ? t("admin.oauth.complete") : flow.status || t("admin.oauth.waiting");
  return <Notice tone="info" title={t("admin.oauth.status", { status })}>
    <ol>
      <li><a href={safeUrl(flow.authorize_url)} target="_blank" rel="noopener noreferrer">{t("admin.oauth.authorizationPage")}</a></li>
      <li><span>{t("admin.oauth.callbackAddress")}: </span><code>{flow.redirect_uri}</code></li>
    </ol>
    <form onSubmit={(event) => { event.preventDefault(); if (callbackValue.trim() && !busy && !flow.complete) void completeOAuthVerification(store, providerId, flow.flow_id); }}><Field label={t("admin.oauth.callbackAddress")}><Textarea aria-label={t("admin.oauth.callbackAddress")} value={callbackValue} placeholder={t("admin.oauth.callbackPlaceholder")} rows={3} disabled={busy} onChange={(e) => setOAuthCallbackUrl(store, providerId, e.target.value)} /></Field>
    <FormFooter><Button  type="submit" loading={verifying} disabled={!callbackValue.trim() || busy || flow.complete}>{t("admin.oauth.completeVerification")}</Button></FormFooter></form>
  </Notice>;
}
