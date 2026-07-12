/* <OAuthProviderCard/> — one provider's verification status + action button + the
   embedded device-code / manual-callback flow when active (legacy
   renderOAuthProviderCard, legacy-app.js:2704-2738). Keyed by provider.id at the
   call site so reconciliation never carries one provider's flow/textarea into
   another's slot. */

import { startOAuthVerification } from "../../../data/adminActions";
import { cx } from "../../../lib/cx";
import { useStore, useStoreHandle } from "../../../store/useStore";
import { formatTimestamp } from "../../../utils/format";
import { oauthProviderErrorText } from "../../../utils/oauth";
import type { OAuthProvider } from "../../../types";
import { Icon } from "../../common/Icon";
import { StatusBadge } from "../../common/StatusBadge";
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
  const busy = useStore((state) => state.busy);
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
        <StatusBadge ok={!!provider.configured} label={t(provider.configured ? "admin.oauth.verified" : "admin.oauth.unverified")} />
      </div>
      <div className="oauth-meta">
        {provider.active ? (
          <span className="chip">
            <span className="dot" />
            {t("admin.oauth.active")}
          </span>
        ) : null}
        {provider.last_refresh ? (
          <span className="muted" style={{ fontSize: "12px" }}>
            {t("admin.oauth.updatedAt", { time: formatTimestamp(provider.last_refresh) })}
          </span>
        ) : null}
      </div>
      {errorText ? (
        <div className="oauth-error" role="alert">
          <Icon name="alert" size={15} />
          <span>{errorText}</span>
        </div>
      ) : null}
      {!provider.default_model && provider.model_catalog_error ? (
        <div className="oauth-error" role="alert">
          <Icon name="alert" size={15} />
          <span>
            {provider.model_catalog_error
              ? t("admin.oauth.catalogError", { error: provider.model_catalog_error })
              : t("admin.oauth.catalogUnavailable")}
          </span>
        </div>
      ) : null}
      <div className="oauth-actions">
        <button
          className={provider.configured ? "btn btn--sm" : "btn btn--primary btn--sm"}
          disabled={busy}
          onClick={() => void startOAuthVerification(store, provider.id)}
        >
          <Icon name="shield" size={14} />
          <span>{t(provider.configured ? "admin.oauth.reverify" : "admin.oauth.startVerification")}</span>
        </button>
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
