/* <CodexOAuthFlow/> — device-code verification UI: verification URL, user code, a
   manual "检查状态" poll button, and the status label (legacy renderCodexOAuthFlow,
   legacy-app.js:2748-2760). No auto-poll — the user clicks to poll. The
   backend-supplied verification_url is run through safeUrl (JSX does not block
   javascript: hrefs). */

import { pollOAuthVerification } from "../../../data/adminActions";
import { safeUrl } from "../../../lib/api";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { OAuthDeviceCodeFlow } from "../../../types";
import { Icon } from "../../common/Icon";
import { LoadingButton } from "../../common/LoadingButton";
import { useI18n } from "../../../i18n";

function flowStatus(t: ReturnType<typeof useI18n>["t"], status: string | undefined): string {
  if (status === "waiting_for_user") return t("admin.oauth.waitingForUser");
  if (status === "waiting_for_callback") return t("admin.oauth.waitingForCallback");
  if (status === "complete") return t("admin.oauth.complete");
  return status || t("admin.oauth.waiting");
}

export interface CodexOAuthFlowProps {
  providerId: string;
  flow: OAuthDeviceCodeFlow;
}

export function CodexOAuthFlow({ providerId, flow }: CodexOAuthFlowProps) {
  const { t } = useI18n();
  const store = useStoreHandle();
  const checking = useStore((state) =>
    state.pendingOperations.includes(`admin:oauth:poll:${providerId}`),
  );

  return (
    <div className="oauth-guide">
      <div className="oauth-line">
        <span>{t("admin.oauth.verificationPage")}</span>
        <a href={safeUrl(flow.verification_url)} target="_blank" rel="noreferrer">
          <span>{flow.verification_url}</span>
          <Icon name="external" size={13} />
        </a>
      </div>
      <div className="oauth-code">{flow.user_code}</div>
      <div className="oauth-actions">
        <LoadingButton
          className="btn--sm"
          loading={checking}
          loadingLabel={t("admin.common.checking")}
          onClick={() => void pollOAuthVerification(store, providerId, flow.flow_id)}
        >
          <Icon name="refresh" size={14} />
          <span>{t("admin.oauth.checkStatus")}</span>
        </LoadingButton>
        <span className="muted" style={{ fontSize: "12px" }} aria-live="polite">
          {t("admin.oauth.status", { status: flowStatus(t, flow.status) })}
        </span>
      </div>
    </div>
  );
}
