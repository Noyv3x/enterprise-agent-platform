import { Button } from "../../ui/beautiful";
import { useRef } from "react";
import { exportOAuthCredentials, importOAuthCredentials } from "../../../data/adminActions";
import { useI18n } from "../../../i18n";
import { useStore, useStoreHandle } from "../../../store/useStore";
import { EmptyState, ResourceList, Section } from "../../ui/beautiful";
import { OAuthProviderCard } from "./OAuthProviderCard";

export function OAuthSettings() {
  const { t } = useI18n();
  const store = useStoreHandle();
  const oauth = useStore((state) => state.oauthProviders);
  const importing = useStore((state) => state.pendingOperations.includes("admin:oauth:import"));
  const exporting = useStore((state) => state.pendingOperations.includes("admin:oauth:export"));
  const providers = oauth?.providers || [];
  const fileInput = useRef<HTMLInputElement>(null);
  return <>
    <Section title={t("admin.oauth.title")} description={t("admin.oauth.description")}>
      {providers.length ? <ResourceList>{providers.map((provider) => <OAuthProviderCard key={provider.id} provider={provider} />)}</ResourceList> : <EmptyState title={t("admin.oauth.empty")} compact />}
    </Section>
    <Section title={t("admin.oauth.credentialsTransfer")}>
      <div className="bui-actions">
      <input ref={fileInput} type="file" hidden accept="application/json,.json" disabled={importing} aria-label={t("admin.oauth.importCredentials")} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file && !importing) void importOAuthCredentials(store, file); }} />
      <Button loading={importing} disabled={importing} onClick={() => fileInput.current?.click()}>{t("admin.oauth.importCredentials")}</Button>
      <Button loading={exporting} disabled={exporting} onClick={() => void exportOAuthCredentials(store)}>{t("admin.oauth.exportCredentials")}</Button></div>
    </Section>
  </>;
}
