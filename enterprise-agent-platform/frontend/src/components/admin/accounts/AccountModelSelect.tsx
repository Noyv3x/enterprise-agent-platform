/* <AccountModelSelect/> — per-account model dropdown driven by the active Agent
   runtime provider's catalog and a help line.

   The effective value is coerced to "" when the saved model is not in the current
   catalog, and submit reads that coerced value. It is re-derived from the original
   user.model_name so a late catalog load recovers the selection. Instead of
   mutating parent state, which a load race could clobber, we mirror
   the coerced value into `coercedRef` each render; the owning form submits
   `coercedRef.current`. The visible <select> is controlled by the coerced value
   so it always shows the correct option. */

import { useEffect, useMemo, type MutableRefObject } from "react";
import { useStore } from "../../../store/useStore";
import type { AgentModelCatalog, AgentRuntimeConfigState, OAuthProvidersState } from "../../../types";
import { useI18n } from "../../../i18n";
import { Select, Typography } from "antd";

const AGENT_PROVIDERS = ["openai-codex", "xai-oauth"];

function activeAgentProviderId(
  oauthProviders: OAuthProvidersState | null,
  runtimeConfig: AgentRuntimeConfigState | null,
): string {
  const provider =
    oauthProviders?.active_provider || runtimeConfig?.config?.provider || "openai-codex";
  return AGENT_PROVIDERS.includes(provider) ? provider : "openai-codex";
}

function agentModelCatalog(
  providerId: string,
  runtimeConfig: AgentRuntimeConfigState | null,
  oauthProviders: OAuthProvidersState | null,
): AgentModelCatalog {
  const normalized = AGENT_PROVIDERS.includes(providerId) ? providerId : "openai-codex";
  const fromOAuth = (oauthProviders?.providers || []).find((item) => item.id === normalized);
  if (oauthProviders) {
    if (!fromOAuth?.configured) {
      return {
        models: [],
        default_model: "",
        error: fromOAuth?.model_catalog_error || "",
      };
    }
    const models = Array.isArray(fromOAuth.models) ? fromOAuth.models : [];
    const recommended = String(fromOAuth.default_model || "").trim();
    return {
      models,
      default_model: models.includes(recommended) ? recommended : models[0] || "",
      error: fromOAuth.model_catalog_error || "",
    };
  }
  const fromConfig = runtimeConfig?.config?.model_catalog?.[normalized];
  if (fromConfig && typeof fromConfig === "object") return fromConfig;
  return { models: [], default_model: "", error: "unavailable" };
}

export interface AccountModelSelectProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** Mirror of the catalog-coerced effective value, read by the form on submit. */
  coercedRef?: MutableRefObject<string>;
}

export function AccountModelSelect({ id, value, onChange, coercedRef }: AccountModelSelectProps) {
  const { t } = useI18n();
  const runtimeConfig = useStore((state) => state.agentRuntimeConfig);
  const oauthProviders = useStore((state) => state.oauthProviders);

  const { models, defaultModel, help, selectValue } = useMemo(() => {
    const providerId = activeAgentProviderId(oauthProviders, runtimeConfig);
    const catalog = agentModelCatalog(providerId, runtimeConfig, oauthProviders);
    const list = Array.isArray(catalog.models) ? catalog.models : [];
    const deploymentModel = String(runtimeConfig?.config?.model || "").trim();
    const recommendedCandidate = String(catalog.default_model || "").trim();
    const recommendedModel = list.includes(recommendedCandidate)
      ? recommendedCandidate
      : list[0] || "";
    const fallback = deploymentModel || recommendedModel || t("admin.model.systemDefault");
    const clean = String(value || "").trim();
    const coerced = clean && list.includes(clean) ? clean : "";
    let helpText: string;
    if (clean && !list.includes(clean)) {
      helpText = t("admin.model.savedUnavailable", { model: clean });
    } else if (catalog.error) {
      helpText = t("admin.model.catalogError", { error: catalog.error });
    } else if (list.length) {
      helpText = t("admin.model.count", { count: list.length });
    } else {
      helpText = t("admin.model.defaultOnly");
    }
    return { models: list, defaultModel: fallback, help: helpText, selectValue: coerced };
  }, [runtimeConfig, oauthProviders, t, value]);

  // Mirror the effective (coerced) value for the submit path. Re-derived from the
  // ORIGINAL `value` against the CURRENT catalog every render, so a late catalog
  // load recovers the selection;
  // the form reads coercedRef.current on submit (always after this effect flushes).
  useEffect(() => {
    if (coercedRef) coercedRef.current = selectValue;
  }, [coercedRef, selectValue]);

  return (
    <div className="eap-admin-model-select">
      <Select
        id={id}
        styles={{ input: { minHeight: 0 } }}
        value={selectValue}
        onChange={onChange}
        options={[
          { value: "", label: t("admin.model.defaultOption", { model: defaultModel }) },
          ...models.map((model) => ({ value: model, label: model })),
        ]}
      />
      <Typography.Text type="secondary">{help}</Typography.Text>
    </div>
  );
}
