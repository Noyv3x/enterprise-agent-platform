/* <SecretsSettings/> — list + set platform-internal secrets, excluding OAuth
   secrets (managed by the OAuth card). Legacy renderSecretsSettings,
   legacy-app.js:2643-2666. */

import { Empty } from "antd";
import { useStore } from "../../../store/useStore";
import { isOAuthSecret } from "../../../utils/oauth";
import { CardHead } from "../../common/CardHead";
import { AdminCard } from "../AdminCard";
import { SecretRow } from "./SecretRow";
import { useI18n } from "../../../i18n";

export function SecretsSettings() {
  const { t } = useI18n();
  const secrets = useStore((state) => state.secrets);
  const rows = secrets.filter((secret) => !isOAuthSecret(secret.key));

  return (
    <AdminCard>
      <CardHead
        title={t("admin.secrets.title")}
        icon="key"
        desc={t("admin.secrets.description")}
      />
      {rows.length ? (
        <div className="list">
          {rows.map((secret) => (
            <SecretRow key={secret.key} secret={secret} />
          ))}
        </div>
      ) : (
        <Empty
          className="muted"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={t("admin.secrets.none")}
        />
      )}
    </AdminCard>
  );
}
