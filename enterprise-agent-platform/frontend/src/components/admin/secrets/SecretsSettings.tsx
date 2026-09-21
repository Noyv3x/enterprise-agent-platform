import { useI18n } from "../../../i18n";
import { useStore } from "../../../store/useStore";
import { isOAuthSecret } from "../../../utils/oauth";
import { EmptyState, Notice, ResourceList, Section } from "../../ui/beautiful";
import { SecretRow } from "./SecretRow";

export function SecretsSettings() {
  const { t } = useI18n();
  const secrets = useStore((state) => state.secrets);
  const rows = secrets.filter((secret) => !isOAuthSecret(secret.key));
  return <Section title={t("admin.secrets.title")} description={t("admin.secrets.description")}>
    <Notice tone="info" title={t("admin.common.leaveBlank")} />
    {rows.length ? <ResourceList>{rows.map((secret) => <SecretRow key={secret.key} secret={secret} />)}</ResourceList> : <EmptyState title={t("admin.secrets.none")} compact />}
  </Section>;
}
