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

export function OAuthProviderCard({ provider }: { provider: OAuthProvider }) {
  const store = useStoreHandle();
  const busy = useStore((state) => state.busy);
  const flow = useStore((state) => state.oauthFlows[provider.id]);
  const callbackValue = useStore((state) => state.oauthCallbackUrls[provider.id] || "");
  const errorText = oauthProviderErrorText(provider);
  const logoChar = (provider.label || "?").trim().charAt(0);

  return (
    <div className={cx("oauth-card", provider.active && "is-active")}>
      <div className="oauth-card__head">
        <div className="oauth-card__id">
          <div className="oauth-card__logo">
            <strong className="mono">{logoChar}</strong>
          </div>
          <div>
            <div className="oauth-card__label">{provider.label}</div>
            {provider.default_model ? (
              <div className="oauth-card__model">{provider.default_model}</div>
            ) : null}
          </div>
        </div>
        <StatusBadge ok={!!provider.configured} label={provider.configured ? "已验证" : "未验证"} />
      </div>
      <div className="oauth-meta">
        {provider.active ? (
          <span className="chip">
            <span className="dot" />
            使用中
          </span>
        ) : null}
        {provider.last_refresh ? (
          <span className="muted" style={{ fontSize: "12px" }}>
            {`更新于 ${formatTimestamp(provider.last_refresh)}`}
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
          <span>{provider.model_catalog_error}</span>
        </div>
      ) : null}
      <div className="oauth-actions">
        <button
          className={provider.configured ? "btn btn--sm" : "btn btn--primary btn--sm"}
          disabled={busy}
          onClick={() => void startOAuthVerification(store, provider.id)}
        >
          <Icon name="shield" size={14} />
          <span>{provider.configured ? "重新验证" : "开始验证"}</span>
        </button>
      </div>
      {flow?.kind === "device_code" ? <CodexOAuthFlow providerId={provider.id} flow={flow} /> : null}
      {flow?.kind === "manual_callback" ? (
        <GrokOAuthFlow providerId={provider.id} flow={flow} callbackValue={callbackValue} />
      ) : null}
      {flow?.complete ? (
        <div className="oauth-guide complete">
          <Icon name="checkCircle" size={16} />
          <span>验证完成，Hermes 已切换到该供应商。</span>
        </div>
      ) : null}
    </div>
  );
}
