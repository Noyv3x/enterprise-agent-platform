/* <OAuthSettings/> — card listing OAuth-verifiable model providers + global
   import/export credential actions (legacy renderOAuthSettings, legacy-app.js:
   2669-2702). The hidden file input is reset (value="") after each pick so the
   same file can be re-selected; both transfer buttons disable while busy. */

import { useRef } from "react";
import { exportOAuthCredentials, importOAuthCredentials } from "../../../data/adminActions";
import { useStore, useStoreHandle } from "../../../store/useStore";
import { CardHead } from "../../common/CardHead";
import { Icon } from "../../common/Icon";
import { OAuthProviderCard } from "./OAuthProviderCard";

export function OAuthSettings() {
  const store = useStoreHandle();
  const busy = useStore((state) => state.busy);
  const oauthProviders = useStore((state) => state.oauthProviders);
  const providers = oauthProviders?.providers || [];
  const inputRef = useRef<HTMLInputElement>(null);

  const handleImportChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void importOAuthCredentials(store, file);
  };

  return (
    <section className="card">
      <CardHead
        title="API 供应商验证"
        icon="shield"
        desc="通过 OAuth 授权模型供应商，验证后 Hermes 自动切换。"
        extra={
          <div className="oauth-transfer">
            <button
              className="btn btn--sm"
              type="button"
              disabled={busy}
              onClick={() => void exportOAuthCredentials(store)}
            >
              <Icon name="download" size={14} />
              <span>导出凭据</span>
            </button>
            <button
              className="btn btn--sm"
              type="button"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              <Icon name="upload" size={14} />
              <span>导入凭据</span>
            </button>
            <input
              ref={inputRef}
              type="file"
              accept="application/json,.json"
              style={{ display: "none" }}
              onChange={handleImportChange}
            />
          </div>
        }
      />
      {providers.length ? (
        <div className="oauth-grid">
          {providers.map((provider) => (
            <OAuthProviderCard key={provider.id} provider={provider} />
          ))}
        </div>
      ) : (
        <div className="muted">未发现可验证的供应商。</div>
      )}
    </section>
  );
}
