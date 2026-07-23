/* <CodexOAuthFlow/> — device-code verification UI: verification URL, user code, a
   manual "检查状态" poll button, and the status label (legacy renderCodexOAuthFlow,
   legacy-app.js:2748-2760). No auto-poll — the user clicks to poll. The
   backend-supplied verification_url is run through safeUrl (JSX does not block
   javascript: hrefs). */

import { Button, Typography } from "antd";
import { pollOAuthVerification } from "../../../data/adminActions";
import { safeUrl } from "../../../lib/api";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { OAuthDeviceCodeFlow } from "../../../types";
import { Icon } from "../../common/Icon";
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
        <Typography.Link href={safeUrl(flow.verification_url)} target="_blank" rel="noreferrer">
          <span>{flow.verification_url}</span>
          <Icon name="external" size={13} />
        </Typography.Link>
      </div>
      <div className="oauth-code">{flow.user_code}</div>
      <div className="oauth-actions">
        <Button
          size="small"
          loading={checking}
          aria-label={t(checking ? "admin.common.checking" : "admin.oauth.checkStatus")}
          onClick={() => void pollOAuthVerification(store, providerId, flow.flow_id)}
          icon={<Icon name="refresh" size={14} />}
        >
          {t("admin.oauth.checkStatus")}
        </Button>
        <Typography.Text className="muted" type="secondary" style={{ fontSize: "12px" }} aria-live="polite">
          {t("admin.oauth.status", { status: flowStatus(t, flow.status) })}
        </Typography.Text>
      </div>
    </div>
  );
}
