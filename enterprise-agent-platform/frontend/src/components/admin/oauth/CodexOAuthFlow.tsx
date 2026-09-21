import { Button } from "../../ui/beautiful";
import { pollOAuthVerification } from "../../../data/adminActions";
import { useI18n } from "../../../i18n";
import { safeUrl } from "../../../lib/api";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { OAuthDeviceCodeFlow } from "../../../types";
import { Notice } from "../../ui/beautiful";
import { copyText } from "../../../utils/clipboard";
import { toast } from "../../../context/ToastContext";

export interface CodexOAuthFlowProps { providerId: string; flow: OAuthDeviceCodeFlow }
export function CodexOAuthFlow({ providerId, flow }: CodexOAuthFlowProps) {
  const { t } = useI18n();
  const store = useStoreHandle();
  const checking = useStore((state) => state.pendingOperations.includes(`admin:oauth:poll:${providerId}`));
  const busy = useStore((state) => state.pendingOperations.some((key) => key.startsWith("admin:oauth:") && key.endsWith(`:${providerId}`)));
  const status = flow.status === "waiting_for_user" ? t("admin.oauth.waitingForUser") : flow.status === "complete" ? t("admin.oauth.complete") : flow.status || t("admin.oauth.waiting");
  return <Notice tone="info" title={t("admin.oauth.status", { status })}>
    <ol>
      <li><a href={safeUrl(flow.verification_url)} target="_blank" rel="noopener noreferrer">{t("admin.oauth.verificationPage")}</a></li>
      <li><div className="bui-actions"><code>{flow.user_code}</code><Button size="sm" onClick={async () => { const copied = await copyText(flow.user_code); toast(t(copied ? "admin.oauth.codeCopied" : "admin.oauth.codeCopyFailed"), { type: copied ? "ok" : "error" }); }}>{t("admin.oauth.copyCode")}</Button></div></li>
      <li><div className="bui-actions"><Button loading={checking} disabled={busy || flow.complete} onClick={() => void pollOAuthVerification(store, providerId, flow.flow_id)}>{t("admin.oauth.checkStatus")}</Button></div></li>
    </ol>
  </Notice>;
}
