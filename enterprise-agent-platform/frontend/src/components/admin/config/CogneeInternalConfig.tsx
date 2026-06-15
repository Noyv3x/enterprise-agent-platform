/* <CogneeInternalConfig/> — edit Cognee .env via the shared descriptor field form
   (legacy renderCogneeInternalConfig, legacy-app.js:2514-2533). On save the diff
   PUTs { env } then reloads BOTH cognee config and runtime (env changes can
   affect Cognee health). The <ConfigForm> is keyed by a descriptor signature so a
   post-save refetch remounts it with fresh data-initial values. */

import { saveCogneeEnv } from "../../../data/adminActions";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { ConfigFieldDescriptor } from "../../../types";
import { CardHead } from "../../common/CardHead";
import { ConfigForm } from "../../common/ConfigForm";

function fieldsSignature(fields: ConfigFieldDescriptor[]): string {
  return fields
    .map((field) => `${field.key}=${String(field.value ?? "")}#${field.configured ? 1 : 0}${field.defaulted ? 1 : 0}`)
    .join("|");
}

export function CogneeInternalConfig() {
  const store = useStoreHandle();
  const cogneeConfig = useStore((state) => state.cogneeConfig);
  const internal = cogneeConfig?.internal || {};
  const envFields = internal.env || [];

  return (
    <section className="card config-software">
      <CardHead title="Cognee 内部配置" icon="settings" desc={internal.env_path || "Cognee .env"} />
      <ConfigForm
        key={`env:${fieldsSignature(envFields)}`}
        fields={envFields}
        attr="envKey"
        buttonText="保存 Cognee 环境变量"
        onSubmit={(updates) => saveCogneeEnv(store, updates)}
      />
    </section>
  );
}
