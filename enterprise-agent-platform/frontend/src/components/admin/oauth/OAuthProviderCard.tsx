import { Button } from "../../ui/beautiful";
import { startOAuthVerification } from "../../../data/adminActions";
import { useI18n } from "../../../i18n";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { OAuthProvider } from "../../../types";
import { formatTimestamp } from "../../../utils/format";
import { oauthProviderErrorText } from "../../../utils/oauth";
import { Notice, ResourceRow, StatusMark } from "../../ui/beautiful";
import { CodexOAuthFlow } from "./CodexOAuthFlow";
import { GrokOAuthFlow } from "./GrokOAuthFlow";

export function OAuthProviderCard({ provider }: { provider: OAuthProvider }) {
  const { t } = useI18n();
  const store = useStoreHandle();
  const flow = useStore((state) => state.oauthFlows[provider.id]);
  const callbackValue = useStore((state) => state.oauthCallbackUrls[provider.id] || "");
  const verifying = useStore((state) => state.pendingOperations.includes(`admin:oauth:start:${provider.id}`));
  const busy = useStore((state) => state.pendingOperations.some((key) => key.startsWith("admin:oauth:") && key.endsWith(`:${provider.id}`)));
  const models = provider.configured ? provider.models || [] : null;
  const recommended = models?.includes(provider.default_model || "") ? provider.default_model! : models?.[0] || "";
  const error = oauthProviderErrorText(provider);
  const label = provider.id === "openai-codex" ? t("admin.oauth.provider.codex") : provider.id === "xai-oauth" ? t("admin.oauth.provider.grok") : provider.label || provider.id;
  return <ResourceRow title={label}
    status={<><StatusMark tone={provider.configured ? "success" : "neutral"}>{t(provider.configured ? "admin.oauth.verified" : "admin.oauth.unverified")}</StatusMark>{provider.active && <StatusMark tone="info">{t("admin.oauth.active")}</StatusMark>}</>}
    meta={provider.last_refresh ? t("admin.oauth.updatedAt", { time: formatTimestamp(provider.last_refresh) }) : undefined}
    description={<><div>{recommended ? t("admin.oauth.recommendedModel", { model: recommended }) : t("admin.oauth.recommendedModelUnavailable")}</div><div>{models ? t("admin.oauth.availableModels", { count: models.length }) : t("admin.oauth.availableModelsUnavailable")}</div></>}
    actions={<Button loading={verifying} disabled={busy} onClick={() => void startOAuthVerification(store, provider.id)}>{t(provider.configured ? "admin.oauth.reverify" : "admin.oauth.startVerification")}</Button>}>
    {error && <Notice tone="danger" title={error} />}
    {provider.model_catalog_error && <Notice tone="warning" title={t("admin.oauth.catalogError", { error: provider.model_catalog_error })} />}
    {flow?.complete ? <Notice tone="success" title={t("admin.oauth.complete")} /> : flow?.kind === "device_code" ? <CodexOAuthFlow providerId={provider.id} flow={flow} /> : flow?.kind === "manual_callback" ? <GrokOAuthFlow providerId={provider.id} flow={flow} callbackValue={callbackValue} /> : null}
  </ResourceRow>;
}
