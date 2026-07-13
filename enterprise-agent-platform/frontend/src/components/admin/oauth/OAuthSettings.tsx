/* <OAuthSettings/> — card listing OAuth-verifiable model providers + global
   import/export credential actions (legacy renderOAuthSettings, legacy-app.js:
   2669-2702). The hidden file input is reset (value="") after each pick so the
   same file can be re-selected; each transfer button tracks only its own
   operation. */

import { useRef } from "react";
import { exportOAuthCredentials, importOAuthCredentials } from "../../../data/adminActions";
import { useStore, useStoreHandle } from "../../../store/useStore";
import { CardHead } from "../../common/CardHead";
import { Icon } from "../../common/Icon";
import { LoadingButton } from "../../common/LoadingButton";
import { OAuthProviderCard } from "./OAuthProviderCard";
import { useI18n } from "../../../i18n";

export function OAuthSettings() {
  const { t } = useI18n();
  const store = useStoreHandle();
  const exporting = useStore((state) => state.pendingOperations.includes("admin:oauth:export"));
  const importing = useStore((state) => state.pendingOperations.includes("admin:oauth:import"));
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
        title={t("admin.oauth.title")}
        icon="shield"
        desc={t("admin.oauth.description")}
        extra={
          <div className="oauth-transfer">
            <LoadingButton
              className="btn--sm"
              type="button"
              loading={exporting}
              loadingLabel={t("admin.common.exporting")}
              onClick={() => void exportOAuthCredentials(store)}
            >
              <Icon name="download" size={14} />
              <span>{t("admin.oauth.exportCredentials")}</span>
            </LoadingButton>
            <LoadingButton
              className="btn--sm"
              type="button"
              loading={importing}
              loadingLabel={t("admin.common.importing")}
              onClick={() => inputRef.current?.click()}
            >
              <Icon name="upload" size={14} />
              <span>{t("admin.oauth.importCredentials")}</span>
            </LoadingButton>
            <input
              ref={inputRef}
              type="file"
              accept="application/json,.json"
              style={{ display: "none" }}
              disabled={importing}
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
        <div className="muted">{t("admin.oauth.empty")}</div>
      )}
    </section>
  );
}
