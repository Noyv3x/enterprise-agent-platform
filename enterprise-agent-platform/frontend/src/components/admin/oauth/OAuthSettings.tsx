import { Button, Space, Upload } from "antd";
import { exportOAuthCredentials, importOAuthCredentials } from "../../../data/adminActions";
import { useI18n } from "../../../i18n";
import { useStore, useStoreHandle } from "../../../store/useStore";
import { EmptyState, ResourceList, Section } from "../../ui/fieldwork";
import { OAuthProviderCard } from "./OAuthProviderCard";

export function OAuthSettings() {
  const { t } = useI18n();
  const store = useStoreHandle();
  const oauth = useStore((state) => state.oauthProviders);
  const importing = useStore((state) => state.pendingOperations.includes("admin:oauth:import"));
  const exporting = useStore((state) => state.pendingOperations.includes("admin:oauth:export"));
  const providers = oauth?.providers || [];
  return <>
    <Section title={t("admin.oauth.title")} description={t("admin.oauth.description")}>
      {providers.length ? <ResourceList>{providers.map((provider) => <OAuthProviderCard key={provider.id} provider={provider} />)}</ResourceList> : <EmptyState title={t("admin.oauth.empty")} compact />}
    </Section>
    <Section title={t("admin.oauth.credentialsTransfer")}>
      <Space wrap>
        <Upload accept="application/json,.json" multiple={false} showUploadList={false} disabled={importing} beforeUpload={(file) => { void importOAuthCredentials(store, file); return false; }}><Button loading={importing} disabled={importing}>{t("admin.oauth.importCredentials")}</Button></Upload>
        <Button loading={exporting} disabled={exporting} onClick={() => void exportOAuthCredentials(store)}>{t("admin.oauth.exportCredentials")}</Button>
      </Space>
    </Section>
  </>;
}
