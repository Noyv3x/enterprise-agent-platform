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

/** A stable signature that changes whenever a descriptor's value / configured /
 *  defaulted flags change, used to remount <ConfigForm> on a post-save refetch. */
function fieldsSignature(fields: ConfigFieldDescriptor[]): string {
  return fields
    .map((field) => `${field.key}=${String(field.value ?? "")}#${field.configured ? 1 : 0}${field.defaulted ? 1 : 0}`)
    .join("|");
}

export function HermesInternalConfig() {
  const store = useStoreHandle();
  const hermesInternalConfig = useStore((state) => state.hermesInternalConfig);
  const internal = hermesInternalConfig?.internal || {};
  const fields = internal.fields || [];
  const envFields = internal.env || [];
  const sections = internal.sections || [];

  return (
    <section className="card config-software">
      <CardHead title="Hermes 内部配置" icon="settings" desc={internal.config_path || "config.yaml"} />
      {internal.yaml_error ? <div className="config-warning">{internal.yaml_error}</div> : null}
      {internal.default_error ? <div className="config-warning">{internal.default_error}</div> : null}
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
        buttonText="保存 Hermes 字段"
        onSubmit={(updates) => saveHermesYamlFields(store, updates)}
      />
      <RawYamlForm
        value={internal.yaml_text || ""}
        onSubmit={(yamlText) => void saveHermesYamlText(store, yamlText)}
      />
      <ConfigForm
        key={`env:${fieldsSignature(envFields)}`}
        fields={envFields}
        attr="envKey"
        buttonText="保存 Hermes 环境变量"
        onSubmit={(updates) => saveHermesEnv(store, updates)}
      />
    </section>
  );
}
