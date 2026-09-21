import { Button, Input, Select, Field } from "../../ui/beautiful";
import { useEffect, useMemo, useState } from "react";
import { saveAgentRuntimeConfig } from "../../../data/adminActions";
import { RUN_IDLE_TIMEOUT_DEFAULT_SECONDS, RUN_IDLE_TIMEOUT_MAXIMUM_SECONDS, RUN_IDLE_TIMEOUT_MINIMUM_SECONDS } from "../../../design-contract.generated";
import { useI18n } from "../../../i18n";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { AgentRuntimeConfigValues } from "../../../types";
import { FormFooter, FormGrid, Notice, Section } from "../../ui/beautiful";

const PROVIDERS = ["openai-codex", "xai-oauth"];
function seed(config: AgentRuntimeConfigValues) {
  return { provider: config.provider || "openai-codex", model: config.model || "", idle: String(config.idle_timeout_seconds ?? RUN_IDLE_TIMEOUT_DEFAULT_SECONDS), concurrency: String(config.max_concurrency ?? 4), compaction: String(config.compaction_threshold ?? 0.8) };
}

export function AgentRuntimeConfig() {
  const { t } = useI18n();
  const store = useStoreHandle();
  const runtime = useStore((state) => state.agentRuntimeConfig);
  const oauth = useStore((state) => state.oauthProviders);
  const saving = useStore((state) => state.pendingOperations.includes("admin:agent-runtime:save"));
  const [draft, setDraft] = useState(() => seed(runtime?.config || {}));
  useEffect(() => setDraft(seed(runtime?.config || {})), [runtime]);
  const catalog = useMemo(() => {
    if (oauth) {
      const provider = oauth.providers.find((item) => item.id === draft.provider);
      return { models: provider?.configured ? provider.models || [] : [], default_model: provider?.default_model || "", error: provider?.model_catalog_error || "" };
    }
    return runtime?.config.model_catalog?.[draft.provider] || { models: [] };
  }, [oauth, runtime, draft.provider]);
  const models = catalog.models || [];
  const recommended = models.includes(catalog.default_model || "") ? catalog.default_model! : models[0] || "";
  const unavailable = !!draft.model && !models.includes(draft.model);
  const dirty = JSON.stringify(draft) !== JSON.stringify(seed(runtime?.config || {}));
  const save = () => {
    if (!dirty || saving) return;
    void saveAgentRuntimeConfig(store, { provider: draft.provider, model: draft.model, idle_timeout_seconds: draft.idle, max_concurrency: draft.concurrency, compaction_threshold: draft.compaction });
  };
  return <Section title={t("admin.agentRuntime.title")} description={t("admin.agentRuntime.description")}>
    <form onSubmit={(event) => { event.preventDefault(); save(); }}><fieldset disabled={saving}><FormGrid>
      <Field label={t("admin.agentRuntime.provider")}><Select aria-label={t("admin.agentRuntime.provider")} value={draft.provider} disabled={saving} options={PROVIDERS.map((value) => ({ value, label: value === "openai-codex" ? t("admin.oauth.provider.codex") : t("admin.oauth.provider.grok") }))} onChange={(provider) => setDraft({ ...draft, provider: String(provider), model: "" })} /></Field>
      <Field label={t("admin.agentRuntime.model")} hint={models.length ? t("admin.model.count", { count: models.length }) : t("admin.agentRuntime.modelUnavailableHint")}><Select aria-label={t("admin.agentRuntime.model")} value={draft.model} disabled={saving || !models.length} onChange={(model) => setDraft({ ...draft, model: String(model) })} options={[
        { value: "", label: recommended ? t("admin.model.autoOption", { model: recommended }) : t("admin.agentRuntime.modelUnavailable") },
        ...(unavailable ? [{ value: draft.model, label: draft.model }] : []),
        ...models.map((value) => ({ value, label: value })),
      ]} /></Field>
      <Field label={t("admin.agentRuntime.maxConcurrency")}><Input aria-label={t("admin.agentRuntime.maxConcurrency")} type="number" min={1} max={64} step={1} value={draft.concurrency} onChange={(e) => setDraft({ ...draft, concurrency: e.target.value })} /></Field>
      <Field label={t("admin.agentRuntime.idleTimeout")} hint={t("admin.agentRuntime.idleTimeoutHint")} ><Input aria-label={t("admin.agentRuntime.idleTimeout")} type="number" min={RUN_IDLE_TIMEOUT_MINIMUM_SECONDS} max={RUN_IDLE_TIMEOUT_MAXIMUM_SECONDS} value={draft.idle} onChange={(e) => setDraft({ ...draft, idle: e.target.value })} /></Field>
      <Field label={t("admin.agentRuntime.compactionThreshold")} hint={t("admin.agentRuntime.compactionThresholdHint")} ><Input aria-label={t("admin.agentRuntime.compactionThreshold")} type="number" min={0.5} max={0.95} step={0.05} value={draft.compaction} onChange={(e) => setDraft({ ...draft, compaction: e.target.value })} /></Field>
    </FormGrid>
    {catalog.error && <Notice tone="warning" title={t("admin.model.catalogError", { error: catalog.error })} />}
    {unavailable && <Notice tone="warning" title={t("admin.model.savedUnavailable", { model: draft.model })} />}
    <FormFooter><Button  type="submit" variant="primary" loading={saving} disabled={!dirty || saving}>{t("admin.agentRuntime.save")}</Button></FormFooter></fieldset></form>
  </Section>;
}
