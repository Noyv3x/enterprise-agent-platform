/* <GrokOAuthFlow/> — manual-callback verification UI: open the authorize URL,
   show the redirect URI, paste the full callback URL, and complete verification
   (legacy renderGrokOAuthFlow, legacy-app.js:2762-2780). The callback textarea is
   controlled by store state (oauthCallbackUrls[providerId]) — the same place
   completeOAuthVerification reads from. The backend-supplied authorize_url runs
   through safeUrl. */

import { completeOAuthVerification, setOAuthCallbackUrl } from "../../../data/adminActions";
import { safeUrl } from "../../../lib/api";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { OAuthManualCallbackFlow } from "../../../types";
import { Icon } from "../../common/Icon";
import { LoadingButton } from "../../common/LoadingButton";
import { useI18n } from "../../../i18n";

function flowStatus(t: ReturnType<typeof useI18n>["t"], status: string | undefined): string {
  if (status === "waiting_for_user") return t("admin.oauth.waitingForUser");
  if (status === "waiting_for_callback") return t("admin.oauth.waitingForCallback");
  if (status === "complete") return t("admin.oauth.complete");
  return status || t("admin.oauth.waiting");
}

export interface GrokOAuthFlowProps {
  providerId: string;
  flow: OAuthManualCallbackFlow;
  callbackValue: string;
}

export function GrokOAuthFlow({ providerId, flow, callbackValue }: GrokOAuthFlowProps) {
  const { t } = useI18n();
  const store = useStoreHandle();
  const verifying = useStore((state) =>
    state.pendingOperations.includes(`admin:oauth:complete:${providerId}`),
  );

  return (
    <div className="oauth-guide">
      <div className="oauth-line">
        <span>{t("admin.oauth.authorizationPage")}</span>
        <a href={safeUrl(flow.authorize_url)} target="_blank" rel="noreferrer">
          <span>{t("admin.oauth.openGrok")}</span>
          <Icon name="external" size={13} />
        </a>
      </div>
      <div className="oauth-line">
        <span>{t("admin.oauth.callbackAddress")}</span>
        <code>{flow.redirect_uri}</code>
      </div>
      <textarea
        placeholder={t("admin.oauth.callbackPlaceholder")}
        value={callbackValue}
        onChange={(event) => setOAuthCallbackUrl(store, providerId, event.target.value)}
      />
      <div className="oauth-actions">
        <LoadingButton
          className="btn--sm"
          variant="primary"
          disabled={!callbackValue.trim()}
          loading={verifying}
          loadingLabel={t("admin.common.verifying")}
          onClick={() => void completeOAuthVerification(store, providerId, flow.flow_id)}
        >
          <Icon name="checkCircle" size={14} />
          <span>{t("admin.oauth.completeVerification")}</span>
        </LoadingButton>
        <span className="muted" style={{ fontSize: "12px" }} aria-live="polite">
          {t("admin.oauth.status", { status: flowStatus(t, flow.status) })}
        </span>
      </div>
    </div>
  );
}
