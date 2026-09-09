import { Button, Form, Input, Typography } from "antd";
import { completeOAuthVerification, setOAuthCallbackUrl } from "../../../data/adminActions";
import { useI18n } from "../../../i18n";
import { safeUrl } from "../../../lib/api";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { OAuthManualCallbackFlow } from "../../../types";
import { FormFooter, Notice } from "../../ui/fieldwork";

export interface GrokOAuthFlowProps { providerId: string; flow: OAuthManualCallbackFlow; callbackValue: string }
export function GrokOAuthFlow({ providerId, flow, callbackValue }: GrokOAuthFlowProps) {
  const { t } = useI18n();
  const store = useStoreHandle();
  const verifying = useStore((state) => state.pendingOperations.includes(`admin:oauth:complete:${providerId}`));
  const busy = useStore((state) => state.pendingOperations.some((key) => key.startsWith("admin:oauth:") && key.endsWith(`:${providerId}`)));
  const status = flow.status === "waiting_for_callback" ? t("admin.oauth.waitingForCallback") : flow.status === "complete" ? t("admin.oauth.complete") : flow.status || t("admin.oauth.waiting");
  return <Notice tone="info" title={t("admin.oauth.status", { status })}>
    <ol>
      <li><Typography.Link href={safeUrl(flow.authorize_url)} target="_blank" rel="noopener noreferrer">{t("admin.oauth.authorizationPage")}</Typography.Link></li>
      <li><Typography.Text>{t("admin.oauth.callbackAddress")}: </Typography.Text><Typography.Text code>{flow.redirect_uri}</Typography.Text></li>
    </ol>
    <Form layout="vertical" onFinish={() => { if (callbackValue.trim() && !busy) void completeOAuthVerification(store, providerId, flow.flow_id); }}>
      <Form.Item label={t("admin.oauth.callbackAddress")}><Input.TextArea aria-label={t("admin.oauth.callbackAddress")} value={callbackValue} placeholder={t("admin.oauth.callbackPlaceholder")} autoSize={{ minRows: 3, maxRows: 6 }} disabled={busy} onChange={(e) => setOAuthCallbackUrl(store, providerId, e.target.value)} /></Form.Item>
      <FormFooter><Button htmlType="submit" loading={verifying} disabled={!callbackValue.trim() || busy || flow.complete}>{t("admin.oauth.completeVerification")}</Button></FormFooter>
    </Form>
  </Notice>;
}
