/* <OAuthSettings/> — card listing OAuth-verifiable model providers + global
   import/export credential actions (legacy renderOAuthSettings, legacy-app.js:
   2669-2702). Upload intercepts the selected JSON locally instead of issuing an
   HTTP upload of its own; each transfer button tracks only its own operation. */

import { Button, Upload } from "antd";
import { exportOAuthCredentials, importOAuthCredentials } from "../../../data/adminActions";
import { useStore, useStoreHandle } from "../../../store/useStore";
import { CardHead } from "../../common/CardHead";
import { Icon } from "../../common/Icon";
import { AdminCard } from "../AdminCard";
import { OAuthProviderCard } from "./OAuthProviderCard";
import { useI18n } from "../../../i18n";

export function OAuthSettings() {
  const { t } = useI18n();
  const store = useStoreHandle();
  const exporting = useStore((state) => state.pendingOperations.includes("admin:oauth:export"));
  const importing = useStore((state) => state.pendingOperations.includes("admin:oauth:import"));
  const oauthProviders = useStore((state) => state.oauthProviders);
  const providers = oauthProviders?.providers || [];

  return (
    <AdminCard>
      <CardHead
        title={t("admin.oauth.title")}
        icon="shield"
        desc={t("admin.oauth.description")}
        extra={
          <div className="oauth-transfer">
            <Button
              className="btn--sm"
              htmlType="button"
              size="small"
              loading={exporting}
              aria-label={t(exporting ? "admin.common.exporting" : "admin.oauth.exportCredentials")}
              onClick={() => void exportOAuthCredentials(store)}
              icon={<Icon name="download" size={14} />}
            >
              {t("admin.oauth.exportCredentials")}
            </Button>
            <Upload
              accept="application/json,.json"
              maxCount={1}
              showUploadList={false}
              disabled={importing}
              beforeUpload={(file) => {
                void importOAuthCredentials(store, file);
                return Upload.LIST_IGNORE;
              }}
            >
              <Button
                className="btn--sm"
                htmlType="button"
                size="small"
                loading={importing}
                aria-label={t(importing ? "admin.common.importing" : "admin.oauth.importCredentials")}
                icon={<Icon name="upload" size={14} />}
              >
                {t("admin.oauth.importCredentials")}
              </Button>
            </Upload>
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
    </AdminCard>
  );
}
