/* <HermesConfig/> — managed Hermes runtime source + OAuth provider + model +
   timeouts + API-server key (legacy renderHermesConfig + syncModelOptions +
   hermesModelCatalog + activeHermesProviderId, legacy-app.js:2138-2272). Lives on
   the `model` admin page below <OAuthSettings/>.

   The model dropdown is a dependent control (legacy syncModelOptions): its option
   list + selected value are derived from the active provider's catalog. Changing
   the provider resets the model to that provider's default. Numbers
   (startup_wait_seconds / timeout_seconds) are kept as STRING state and sent raw;
   the api_key is never seeded (empty = keep) and clears via the post-save re-seed
   (loadSettings replaces hermesConfig). */

import { useEffect, useMemo, useState } from "react";
import { installHermes, saveHermesConfig } from "../../../data/adminActions";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type {
  HermesConfigState,
  HermesConfigValues,
  HermesModelCatalog,
  OAuthProvidersState,
} from "../../../types";
import { CardHead } from "../../common/CardHead";
import { Field } from "../../common/Field";
import { Icon } from "../../common/Icon";

const HERMES_PROVIDERS = ["openai-codex", "xai-oauth"];

function hermesModelCatalog(
  providerId: string,
  hermesConfig: HermesConfigState | null,
  oauthProviders: OAuthProvidersState | null,
): HermesModelCatalog {
  const normalized = HERMES_PROVIDERS.includes(providerId) ? providerId : "openai-codex";
  const fromConfig = hermesConfig?.config?.model_catalog?.[normalized];
  if (fromConfig && typeof fromConfig === "object") return fromConfig;
  const fromOAuth = (oauthProviders?.providers || []).find((item) => item.id === normalized);
  if (fromOAuth) {
    return {
      models: fromOAuth.models || [],
      default_model: fromOAuth.default_model || "",
      error: fromOAuth.model_catalog_error || "",
    };
  }
  return { models: [], default_model: "", error: "Hermes 模型目录不可用" };
}

interface ResolvedModel {
  models: string[];
  value: string;
  disabled: boolean;
  hint: string;
}

/** Mirror of legacy syncModelOptions(preferredModel): derive the option list,
 *  the selected value and the hint from the catalog of `provider`. */
function resolveModel(
  provider: string,
  preferred: string,
  hermesConfig: HermesConfigState | null,
  oauthProviders: OAuthProvidersState | null,
): ResolvedModel {
  const catalog = hermesModelCatalog(provider, hermesConfig, oauthProviders);
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  const current = String(preferred || "").trim();
  const fallback = String(catalog.default_model || "").trim();
  if (!models.length) {
    return {
      models: [],
      value: "",
      disabled: true,
      hint: catalog.error || "需要先安装/启动托管 Hermes 后读取模型目录。",
    };
  }
  const value = models.includes(current) ? current : models.includes(fallback) ? fallback : models[0];
  return { models, value, disabled: false, hint: `${models.length} 个模型，来源：Hermes` };
}

interface HermesFormState {
  manageHermes: boolean;
  repoPath: string;
  apiUrl: string;
  provider: string;
  providerBaseUrl: string;
  /** The user's preferred model; the effective value is resolved against the
   *  catalog (see resolveModel). "" means "default for the current provider". */
  modelPreferred: string;
  installExtras: string;
  startupWait: string;
  timeoutSeconds: string;
  apiKey: string;
}

function seedForm(hermes: HermesConfigValues): HermesFormState {
  return {
    manageHermes: hermes.manage_hermes !== false,
    repoPath: hermes.repo_path || "",
    apiUrl: hermes.api_url || "",
    provider: HERMES_PROVIDERS.includes(hermes.provider || "")
      ? (hermes.provider as string)
      : "openai-codex",
    providerBaseUrl: hermes.provider_base_url || "",
    modelPreferred: hermes.model || "",
    installExtras: hermes.install_extras || "",
    startupWait: String(hermes.startup_wait_seconds ?? 8),
    timeoutSeconds: String(hermes.timeout_seconds ?? 240),
    apiKey: "",
  };
}

export function HermesConfig() {
  const store = useStoreHandle();
  const busy = useStore((state) => state.busy);
  const hermesConfig = useStore((state) => state.hermesConfig);
  const oauthProviders = useStore((state) => state.oauthProviders);
  const hermes = hermesConfig?.config || {};

  const [form, setForm] = useState<HermesFormState>(() => seedForm(hermesConfig?.config || {}));

  // Re-seed when hermesConfig changes (initial async load + post-save reload via
  // loadSettings). Depends on hermesConfig only: a late oauthProviders load must
  // re-resolve the model (handled below via useMemo) without resetting edits.
  useEffect(() => {
    setForm(seedForm(hermesConfig?.config || {}));
  }, [hermesConfig]);

  const resolved = useMemo(
    () => resolveModel(form.provider, form.modelPreferred, hermesConfig, oauthProviders),
    [form.provider, form.modelPreferred, hermesConfig, oauthProviders],
  );

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void saveHermesConfig(store, {
      manage_hermes: form.manageHermes,
      repo_path: form.repoPath,
      api_url: form.apiUrl,
      provider: form.provider,
      provider_base_url: form.providerBaseUrl,
      model: resolved.value,
      install_extras: form.installExtras,
      startup_wait_seconds: form.startupWait,
      timeout_seconds: form.timeoutSeconds,
      api_key: form.apiKey,
    });
  };

  return (
    <section className="card config-form">
      <CardHead title="Hermes 配置" icon="settings" desc="运行时来源、API 供应商与模型参数。" />
      <form onSubmit={handleSubmit}>
        <label className="check-row">
          <input
            type="checkbox"
            checked={form.manageHermes}
            onChange={(event) => setForm((prev) => ({ ...prev, manageHermes: event.target.checked }))}
          />
          <div className="check-row__text">
            <strong>由平台托管 Hermes</strong>
            <span>自动安装与管理运行时生命周期</span>
          </div>
        </label>
        <div className="config-grid">
          <div className="field--full">
            <Field label="源码路径">
              <input
                value={form.repoPath}
                onChange={(event) => setForm((prev) => ({ ...prev, repoPath: event.target.value }))}
              />
            </Field>
          </div>
          <div className="field--full">
            <Field label="API URL">
              <input
                value={form.apiUrl}
                onChange={(event) => setForm((prev) => ({ ...prev, apiUrl: event.target.value }))}
              />
            </Field>
          </div>
          <Field label="API 供应商">
            <select
              value={form.provider}
              onChange={(event) =>
                // Changing provider resets the model to that provider's default
                // (legacy: provider.change → syncModelOptions("")).
                setForm((prev) => ({ ...prev, provider: event.target.value, modelPreferred: "" }))
              }
            >
              <option value="openai-codex">Codex OAuth</option>
              <option value="xai-oauth">Grok OAuth</option>
            </select>
          </Field>
          <Field label="供应商 Base URL">
            <input
              value={form.providerBaseUrl}
              placeholder="默认使用所选 OAuth 供应商 endpoint"
              onChange={(event) =>
                setForm((prev) => ({ ...prev, providerBaseUrl: event.target.value }))
              }
            />
          </Field>
          <Field label="模型">
            <div className="field-stack">
              <select
                value={resolved.value}
                disabled={resolved.disabled}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, modelPreferred: event.target.value }))
                }
              >
                {resolved.disabled ? (
                  <option value="">Hermes 模型目录不可用</option>
                ) : (
                  resolved.models.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))
                )}
              </select>
              <div className="field-help">{resolved.hint}</div>
            </div>
          </Field>
          <Field label="安装 extras">
            <input
              value={form.installExtras}
              placeholder="可选，例如 dev"
              onChange={(event) => setForm((prev) => ({ ...prev, installExtras: event.target.value }))}
            />
          </Field>
          <Field label="启动等待秒数">
            <input
              type="number"
              min="0"
              max="120"
              step="0.5"
              value={form.startupWait}
              onChange={(event) => setForm((prev) => ({ ...prev, startupWait: event.target.value }))}
            />
          </Field>
          <Field label="请求超时秒数">
            <input
              type="number"
              min="1"
              max="3600"
              step="1"
              value={form.timeoutSeconds}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, timeoutSeconds: event.target.value }))
              }
            />
          </Field>
          <Field label="API Server Key">
            <input
              type="password"
              autoComplete="off"
              placeholder={hermes.api_key_configured ? "保持不变" : "API server key"}
              value={form.apiKey}
              onChange={(event) => setForm((prev) => ({ ...prev, apiKey: event.target.value }))}
            />
          </Field>
        </div>
        <div className="form-actions">
          <button className="btn btn--primary" type="submit" disabled={busy}>
            <span>保存配置</span>
          </button>
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={() => void installHermes(store)}
          >
            <Icon name="download" size={15} />
            <span>从源码重装</span>
          </button>
        </div>
      </form>
    </section>
  );
}
