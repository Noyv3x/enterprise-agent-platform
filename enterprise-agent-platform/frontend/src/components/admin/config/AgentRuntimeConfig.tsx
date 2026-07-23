import { Button, Input, Select } from "antd";
import { useEffect, useId, useMemo, useState } from "react";
import { saveAgentRuntimeConfig } from "../../../data/adminActions";
import {
  RUN_IDLE_TIMEOUT_DEFAULT_SECONDS,
  RUN_IDLE_TIMEOUT_MAXIMUM_SECONDS,
  RUN_IDLE_TIMEOUT_MINIMUM_SECONDS,
} from "../../../design-contract.generated";
import { useI18n, type Translator } from "../../../i18n";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type {
  AgentModelCatalog,
  AgentRuntimeConfigState,
  AgentRuntimeConfigValues,
  OAuthProvidersState,
} from "../../../types";
import { CardHead } from "../../common/CardHead";
import { Field } from "../../common/Field";
import { AdminCard } from "../AdminCard";

const AGENT_PROVIDERS = ["openai-codex", "xai-oauth"];

function agentModelCatalog(
  providerId: string,
  runtimeConfig: AgentRuntimeConfigState | null,
  oauthProviders: OAuthProvidersState | null,
): AgentModelCatalog {
  const normalized = AGENT_PROVIDERS.includes(providerId) ? providerId : "openai-codex";
  const fromConfig = runtimeConfig?.config?.model_catalog?.[normalized];
  if (fromConfig && typeof fromConfig === "object") return fromConfig;
  const fromOAuth = (oauthProviders?.providers || []).find((item) => item.id === normalized);
  if (fromOAuth) {
    return {
      models: fromOAuth.models || [],
      default_model: fromOAuth.default_model || "",
      error: fromOAuth.model_catalog_error || "",
    };
  }
  return { models: [], default_model: "", error: "" };
}

interface ResolvedModel {
  models: string[];
  value: string;
  disabled: boolean;
  hint: string;
}

function resolveModel(
  t: Translator,
  provider: string,
  preferred: string,
  runtimeConfig: AgentRuntimeConfigState | null,
  oauthProviders: OAuthProvidersState | null,
): ResolvedModel {
  const catalog = agentModelCatalog(provider, runtimeConfig, oauthProviders);
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  const current = String(preferred || "").trim();
  const fallback = String(catalog.default_model || "").trim();
  if (!models.length) {
    return {
      models: [],
      value: "",
      disabled: true,
      hint: catalog.error
        ? t("admin.model.catalogError", { error: catalog.error })
        : t("admin.agentRuntime.modelUnavailableHint"),
    };
  }
  const value = models.includes(current) ? current : models.includes(fallback) ? fallback : models[0];
  const hint = catalog.error
    ? t("admin.model.catalogError", { error: catalog.error })
    : t("admin.model.count", { count: models.length });
  return { models, value, disabled: false, hint };
}

interface AgentRuntimeFormState {
  provider: string;
  modelPreferred: string;
  idleTimeoutSeconds: string;
  maxConcurrency: string;
  compactionThreshold: string;
}

function seedForm(config: AgentRuntimeConfigValues): AgentRuntimeFormState {
  return {
    provider: AGENT_PROVIDERS.includes(config.provider || "")
      ? (config.provider as string)
      : "openai-codex",
    modelPreferred: config.model || "",
    idleTimeoutSeconds: String(
      config.idle_timeout_seconds ?? RUN_IDLE_TIMEOUT_DEFAULT_SECONDS,
    ),
    maxConcurrency: String(config.max_concurrency ?? 4),
    compactionThreshold: String(config.compaction_threshold ?? 0.8),
  };
}

export function AgentRuntimeConfig() {
  const { t } = useI18n();
  const providerId = useId();
  const modelId = useId();
  const modelHintId = useId();
  const maxConcurrencyId = useId();
  const idleTimeoutId = useId();
  const idleTimeoutHintId = useId();
  const compactionId = useId();
  const compactionHintId = useId();
  const store = useStoreHandle();
  const saving = useStore((state) =>
    state.pendingOperations.includes("admin:agent-runtime:save"),
  );
  const runtimeConfig = useStore((state) => state.agentRuntimeConfig);
  const oauthProviders = useStore((state) => state.oauthProviders);
  const [form, setForm] = useState<AgentRuntimeFormState>(() =>
    seedForm(runtimeConfig?.config || {}),
  );

  useEffect(() => {
    setForm(seedForm(runtimeConfig?.config || {}));
  }, [runtimeConfig]);

  const resolved = useMemo(
    () => resolveModel(t, form.provider, form.modelPreferred, runtimeConfig, oauthProviders),
    [form.provider, form.modelPreferred, runtimeConfig, oauthProviders, t],
  );
  const dirty = JSON.stringify(form) !== JSON.stringify(seedForm(runtimeConfig?.config || {}));

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void saveAgentRuntimeConfig(store, {
      provider: form.provider,
      model: resolved.value,
      idle_timeout_seconds: form.idleTimeoutSeconds,
      max_concurrency: form.maxConcurrency,
      compaction_threshold: form.compactionThreshold,
    });
  };

  return (
    <AdminCard className="config-form">
      <CardHead
        title={t("admin.agentRuntime.title")}
        icon="settings"
        desc={t("admin.agentRuntime.description")}
      />
      <form onSubmit={handleSubmit}>
        <div className="config-grid">
          <Field label={t("admin.agentRuntime.provider")}>
            <Select
              id={providerId}
              aria-label={t("admin.agentRuntime.provider")}
              value={form.provider}
              options={[
                { value: "openai-codex", label: t("admin.oauth.provider.codex") },
                { value: "xai-oauth", label: t("admin.oauth.provider.grok") },
              ]}
              onChange={(value) =>
                setForm((previous) => ({
                  ...previous,
                  provider: value,
                  modelPreferred: "",
                }))
              }
            />
          </Field>
          <Field label={t("admin.agentRuntime.model")}>
            <div className="field-stack">
              <Select
                id={modelId}
                aria-label={t("admin.agentRuntime.model")}
                value={resolved.value}
                disabled={resolved.disabled}
                aria-describedby={modelHintId}
                options={resolved.disabled
                  ? [{ value: "", label: t("admin.agentRuntime.modelUnavailable") }]
                  : resolved.models.map((model) => ({ value: model, label: model }))}
                onChange={(value) =>
                  setForm((previous) => ({ ...previous, modelPreferred: value }))
                }
              />
              <div className="field-help" id={modelHintId}>{resolved.hint}</div>
            </div>
          </Field>
          <Field label={t("admin.agentRuntime.maxConcurrency")}>
            <Input
              id={maxConcurrencyId}
              aria-label={t("admin.agentRuntime.maxConcurrency")}
              type="number"
              min="1"
              max="64"
              step="1"
              value={form.maxConcurrency}
              onChange={(event) =>
                setForm((previous) => ({ ...previous, maxConcurrency: event.target.value }))
              }
            />
          </Field>
          <Field label={t("admin.agentRuntime.idleTimeout")}>
            <div className="field-stack">
              <Input
                id={idleTimeoutId}
                aria-label={t("admin.agentRuntime.idleTimeout")}
                type="number"
                min={RUN_IDLE_TIMEOUT_MINIMUM_SECONDS}
                max={RUN_IDLE_TIMEOUT_MAXIMUM_SECONDS}
                step="1"
                value={form.idleTimeoutSeconds}
                aria-describedby={idleTimeoutHintId}
                onChange={(event) =>
                  setForm((previous) => ({
                    ...previous,
                    idleTimeoutSeconds: event.target.value,
                  }))
                }
              />
              <div className="field-help" id={idleTimeoutHintId}>
                {t("admin.agentRuntime.idleTimeoutHint")}
              </div>
            </div>
          </Field>
          <Field label={t("admin.agentRuntime.compactionThreshold")}>
            <div className="field-stack">
              <Input
                id={compactionId}
                aria-label={t("admin.agentRuntime.compactionThreshold")}
                type="number"
                min="0.5"
                max="0.95"
                step="0.05"
                value={form.compactionThreshold}
                aria-describedby={compactionHintId}
                onChange={(event) =>
                  setForm((previous) => ({
                    ...previous,
                    compactionThreshold: event.target.value,
                  }))
                }
              />
              <div className="field-help" id={compactionHintId}>
                {t("admin.agentRuntime.compactionThresholdHint")}
              </div>
            </div>
          </Field>
        </div>
        <div className="form-actions">
          <Button
            type="primary"
            htmlType="submit"
            disabled={!dirty}
            loading={saving}
          >
            {t(saving ? "admin.common.saving" : "admin.agentRuntime.save")}
          </Button>
        </div>
      </form>
    </AdminCard>
  );
}
