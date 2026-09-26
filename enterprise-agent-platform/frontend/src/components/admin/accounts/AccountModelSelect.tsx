import { Select } from "antd";
import { useStore } from "../../../store/useStore";
import { useI18n } from "../../../i18n";
import { CODEX_PROVIDER_ID } from "../../../utils/oauth";
import { Notice } from "../../ui/fieldwork";

export interface AccountModelSelectProps { id?: string; value: string; onChange: (value: string) => void }

export function AccountModelSelect({ id, value, onChange }: AccountModelSelectProps) {
  const { t } = useI18n();
  const runtime = useStore((state) => state.agentRuntimeConfig);
  const oauth = useStore((state) => state.oauthProviders);
  const provider = oauth?.providers.find((item) => item.id === CODEX_PROVIDER_ID);
  const catalog = oauth
    ? { models: provider?.configured ? provider.models || [] : [], default_model: provider?.configured ? provider.default_model : "", error: provider?.model_catalog_error }
    : runtime?.config?.model_catalog?.[CODEX_PROVIDER_ID];
  const models = catalog?.models || [];
  const recommendation = models.includes(catalog?.default_model || "") ? catalog?.default_model : models[0];
  const inherited = runtime?.config?.model || recommendation;
  const unavailable = !!value && !models.includes(value);
  return <>
    <Select id={id} style={{ width: "100%" }} value={value} onChange={onChange} options={[
      { value: "", label: inherited ? t("admin.model.defaultOption", { model: inherited }) : t("admin.model.inheritPolicy") },
      ...(unavailable ? [{ value, label: value }] : []), ...models.map((model) => ({ value: model, label: model })),
    ]} />
    {unavailable && <Notice tone="warning" title={t("admin.model.savedUnavailable", { model: value })} />}
    {catalog?.error && <Notice tone="warning" title={t("admin.model.catalogError", { error: catalog.error })} />}
    <p className="mt-1.5 text-[12.5px] text-ink-3">{models.length ? t("admin.model.count", { count: models.length }) : t("admin.model.defaultOnly")}</p>
  </>;
}
