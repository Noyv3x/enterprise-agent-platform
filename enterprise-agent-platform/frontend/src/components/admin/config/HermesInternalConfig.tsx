/* <HermesInternalConfig/> — edit Hermes config.yaml three ways: descriptor fields
   (yaml_updates), raw YAML text (yaml_text), and .env vars (env). All three PUT
   to the same endpoint with different body keys, then reload ONLY
   hermes/internal-config (legacy renderHermesInternalConfig, legacy-app.js:
   2458-2512).

   Each <ConfigForm> is keyed by a signature of its descriptors so a post-save
   refetch remounts it with fresh data-initial values — without that, an already-
   saved field would diff against its stale initial and be re-sent on the next
   submit. config-warning blocks surface server-side parse errors; the read-only
   section chips mirror renderConfigSections (first 18). */

import {
  saveHermesEnv,
  saveHermesYamlFields,
  saveHermesYamlText,
} from "../../../data/adminActions";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { ConfigFieldDescriptor } from "../../../types";
import { CardHead } from "../../common/CardHead";
import { ConfigForm } from "../../common/ConfigForm";
import { RawYamlForm } from "./RawYamlForm";
import { useI18n } from "../../../i18n";

/** A stable signature that changes whenever a descriptor's value / configured /
 *  defaulted flags change, used to remount <ConfigForm> on a post-save refetch. */
function fieldsSignature(fields: ConfigFieldDescriptor[]): string {
  return fields
    .map((field) => `${field.key}=${String(field.value ?? "")}#${field.configured ? 1 : 0}${field.defaulted ? 1 : 0}`)
    .join("|");
}

export function HermesInternalConfig() {
  const { t } = useI18n();
  const store = useStoreHandle();
  const hermesInternalConfig = useStore((state) => state.hermesInternalConfig);
  const internal = hermesInternalConfig?.internal || {};
  const fields = internal.fields || [];
  const envFields = internal.env || [];
  const sections = internal.sections || [];
  const savingFields = useStore((state) =>
    state.pendingOperations.includes("admin:hermes:fields:save"),
  );
  const approvalMode = String(fields.find((field) => field.key === "approvals.mode")?.value || "manual");
  const yoloEnabled = approvalMode === "off";

  return (
    <section className="card config-software">
      <CardHead title={t("admin.config.hermesInternal.title")} icon="settings" desc={internal.config_path || "config.yaml"} />
      {internal.yaml_error ? <div className="config-warning">{internal.yaml_error}</div> : null}
      {internal.default_error ? <div className="config-warning">{internal.default_error}</div> : null}
      <label className="check-row config-yolo">
        <input
          checked={yoloEnabled}
          disabled={savingFields}
          aria-busy={savingFields || undefined}
          onChange={(event) =>
            void saveHermesYamlFields(store, { "approvals.mode": event.currentTarget.checked ? "off" : "manual" })
          }
          type="checkbox"
        />
        <span className="check-row__text">
          <strong>{t("admin.config.hermesInternal.yolo")}</strong>
          <span>{yoloEnabled ? t("admin.config.hermesInternal.yoloEnabled") : t("admin.config.hermesInternal.approvalMode", { mode: approvalMode || "manual" })}</span>
        </span>
      </label>
      {sections.length ? (
        <div className="config-sections">
          {sections.slice(0, 18).map((section, index) => (
            <span className="chip" key={`${section.key}-${index}`}>
              <span className="chip__id">{section.key}</span>
              <span>{section.detail}</span>
            </span>
          ))}
        </div>
      ) : null}
      <ConfigForm
        key={`fields:${fieldsSignature(fields)}`}
        fields={fields}
        attr="yamlKey"
        buttonText={t("admin.config.hermesInternal.saveFields")}
        onSubmit={(updates) => saveHermesYamlFields(store, updates)}
        operationKey="admin:hermes:fields:save"
        loadingLabel={t("admin.common.saving")}
      />
      <RawYamlForm
        value={internal.yaml_text || ""}
        onSubmit={(yamlText) => void saveHermesYamlText(store, yamlText)}
      />
      <ConfigForm
        key={`env:${fieldsSignature(envFields)}`}
        fields={envFields}
        attr="envKey"
        buttonText={t("admin.config.hermesInternal.saveEnv")}
        onSubmit={(updates) => saveHermesEnv(store, updates)}
        operationKey="admin:hermes:env:save"
        loadingLabel={t("admin.common.saving")}
      />
    </section>
  );
}
