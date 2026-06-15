/* <AccountModelSelect/> — per-account model dropdown driven by the active Hermes
   provider's catalog + a help line (legacy accountModelControl / hermesModelCatalog
   / activeHermesProviderId, legacy-app.js:2138-2183).

   The legacy <select>'s effective value is COERCED to "" when the saved model
   isn't in the current catalog, and the submit reads that coerced DOM value. The
   legacy code re-derives this from the ORIGINAL user.model_name on every full
   teardown, so a late catalog load recovers the selection. To match that exactly
   (instead of mutating parent state, which a load race could clobber), we mirror
   the coerced value into `coercedRef` each render; the owning form submits
   `coercedRef.current`. The visible <select> is controlled by the coerced value
   so it always shows the correct option. */

import { useEffect, useMemo, type MutableRefObject } from "react";
import { useStore } from "../../../store/useStore";
import type { HermesConfigState, HermesModelCatalog, OAuthProvidersState } from "../../../types";

const HERMES_PROVIDERS = ["openai-codex", "xai-oauth"];

function activeHermesProviderId(
  oauthProviders: OAuthProvidersState | null,
  hermesConfig: HermesConfigState | null,
): string {
  const provider =
    oauthProviders?.active_provider || hermesConfig?.config?.provider || "openai-codex";
  return HERMES_PROVIDERS.includes(provider) ? provider : "openai-codex";
}

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

export interface AccountModelSelectProps {
  value: string;
  onChange: (value: string) => void;
  /** Mirror of the catalog-coerced effective value, read by the form on submit. */
  coercedRef?: MutableRefObject<string>;
}

export function AccountModelSelect({ value, onChange, coercedRef }: AccountModelSelectProps) {
  const hermesConfig = useStore((state) => state.hermesConfig);
  const oauthProviders = useStore((state) => state.oauthProviders);

  const { models, defaultModel, help, selectValue } = useMemo(() => {
    const providerId = activeHermesProviderId(oauthProviders, hermesConfig);
    const catalog = hermesModelCatalog(providerId, hermesConfig, oauthProviders);
    const list = Array.isArray(catalog.models) ? catalog.models : [];
    const fallback = catalog.default_model || hermesConfig?.config?.model || "系统默认";
    const clean = String(value || "").trim();
    const coerced = clean && list.includes(clean) ? clean : "";
    let helpText: string;
    if (clean && !list.includes(clean)) {
      helpText = `已保存模型 ${clean} 不在当前 Hermes 目录，保存后将改为系统默认。`;
    } else if (list.length) {
      helpText = `${list.length} 个模型，来源：Hermes`;
    } else {
      helpText = catalog.error || "当前仅可使用系统默认模型。";
    }
    return { models: list, defaultModel: fallback, help: helpText, selectValue: coerced };
  }, [hermesConfig, oauthProviders, value]);

  // Mirror the effective (coerced) value for the submit path. Re-derived from the
  // ORIGINAL `value` against the CURRENT catalog every render, so a late catalog
  // load recovers the selection (matching the legacy per-teardown recompute);
  // the form reads coercedRef.current on submit (always after this effect flushes).
  useEffect(() => {
    if (coercedRef) coercedRef.current = selectValue;
  }, [coercedRef, selectValue]);

  return (
    <div className="field-stack">
      <select value={selectValue} onChange={(event) => onChange(event.target.value)}>
        <option value="">{`系统默认 (${defaultModel})`}</option>
        {models.map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
      </select>
      <div className="field-help">{help}</div>
    </div>
  );
}
