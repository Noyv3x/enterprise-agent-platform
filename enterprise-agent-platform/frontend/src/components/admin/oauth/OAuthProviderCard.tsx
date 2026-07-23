/* <OAuthProviderCard/> — one provider's verification status + action button + the
   embedded device-code / manual-callback flow when active (legacy
   renderOAuthProviderCard, legacy-app.js:2704-2738). Keyed by provider.id at the
   call site so reconciliation never carries one provider's flow/textarea into
   another's slot. */

import { Alert, Badge, Button, Tag, Typography } from "antd";
import { startOAuthVerification } from "../../../data/adminActions";
import { cx } from "../../../lib/cx";
import { useStore, useStoreHandle } from "../../../store/useStore";
import { formatTimestamp } from "../../../utils/format";
import { oauthProviderErrorText } from "../../../utils/oauth";
import type { OAuthProvider } from "../../../types";
import { Icon } from "../../common/Icon";
import { CodexOAuthFlow } from "./CodexOAuthFlow";
import { GrokOAuthFlow } from "./GrokOAuthFlow";
import { useI18n, type Translator } from "../../../i18n";

function providerLabel(t: Translator, id: string, fallback: string | undefined): string {
  if (id === "openai-codex") return t("admin.oauth.provider.codex");
  if (id === "xai-oauth") return t("admin.oauth.provider.grok");
  return fallback || id;
}

export function OAuthProviderCard({ provider }: { provider: OAuthProvider }) {
  const { t } = useI18n();
  const store = useStoreHandle();
  const verifying = useStore((state) =>
    state.pendingOperations.includes(`admin:oauth:start:${provider.id}`),
  );
  const flow = useStore((state) => state.oauthFlows[provider.id]);
  const callbackValue = useStore((state) => state.oauthCallbackUrls[provider.id] || "");
  const errorText = oauthProviderErrorText(provider);
  const label = providerLabel(t, provider.id, provider.label);
  const logoChar = (label || "?").trim().charAt(0);

  return (
    <div className={cx("oauth-card", provider.active && "is-active")}>
      <div className="oauth-card__head">
        <div className="oauth-card__id">
          <div className="oauth-card__logo">
            <strong className="mono">{logoChar}</strong>
          </div>
          <div>
            <div className="oauth-card__label">{label}</div>
            {provider.default_model ? (
              <div className="oauth-card__model">{provider.default_model}</div>
            ) : null}
          </div>
        </div>
        <Badge
          status={provider.configured ? "success" : "default"}
          text={t(provider.configured ? "admin.oauth.verified" : "admin.oauth.unverified")}
        />
      </div>
      <div className="oauth-meta">
        {provider.active ? (
          <Tag className="chip" color="processing" variant="filled">
            {t("admin.oauth.active")}
          </Tag>
        ) : null}
        {provider.last_refresh ? (
          <Typography.Text className="muted" type="secondary" style={{ fontSize: "12px" }}>
            {t("admin.oauth.updatedAt", { time: formatTimestamp(provider.last_refresh) })}
          </Typography.Text>
        ) : null}
      </div>
      {errorText ? (
        <Alert className="oauth-error" type="error" showIcon message={errorText} />
      ) : null}
      {provider.model_catalog_error ? (
        <Alert
          className="oauth-error"
          type="error"
          showIcon
          message={provider.model_catalog_error
            ? t("admin.oauth.catalogError", { error: provider.model_catalog_error })
            : t("admin.oauth.catalogUnavailable")}
        />
      ) : null}
      <div className="oauth-actions">
        <Button
          className="btn--sm"
          type={provider.configured ? "default" : "primary"}
          size="small"
          loading={verifying}
          aria-label={t(verifying
            ? "admin.common.verifying"
            : provider.configured
              ? "admin.oauth.reverify"
              : "admin.oauth.startVerification")}
          onClick={() => void startOAuthVerification(store, provider.id)}
          icon={<Icon name="shield" size={14} />}
        >
          {t(provider.configured ? "admin.oauth.reverify" : "admin.oauth.startVerification")}
        </Button>
      </div>
      {flow?.kind === "device_code" ? <CodexOAuthFlow providerId={provider.id} flow={flow} /> : null}
      {flow?.kind === "manual_callback" ? (
        <GrokOAuthFlow providerId={provider.id} flow={flow} callbackValue={callbackValue} />
      ) : null}
      {flow?.complete ? (
        <div className="oauth-guide complete">
          <Icon name="checkCircle" size={16} />
          <span>{t("admin.oauth.completeDetail")}</span>
        </div>
      ) : null}
    </div>
  );
}
