/* <ConfigForm/> — the generic descriptor-driven config editor, ported from
   legacy renderConfigFieldsForm + groupedConfigFields + renderConfigField +
   collectConfigUpdates (legacy-app.js:2541-2641). Used by managed service
   configuration pages.

   The form is uncontrolled (each field carries a data-initial attribute);
   on submit we collect a CHANGED-ONLY diff via the DOM, preserving the legacy
   skip rules verbatim:
     - skip if the value equals its data-initial,
     - skip empty password fields (keep existing secret),
     - for env attrs, skip empty values entirely,
     - values are sent as strings (numbers are NOT coerced — backend parses).
   If the diff is empty the submit is a no-op (onSubmit is not called). */

import { useState } from "react";
import { useStore } from "../../store/useStore";
import type { ConfigFieldDescriptor } from "../../types";
import { ConfigFieldControl, type ConfigAttr } from "./ConfigFieldControl";
import { useI18n } from "../../i18n";
import { CONFIG_FIELD_GROUP_KEYS, CONFIG_FIELD_LABEL_KEYS } from "../../i18n/messages/admin";
import { LoadingButton } from "./LoadingButton";

export interface ConfigFormProps {
  fields: ConfigFieldDescriptor[];
  attr: ConfigAttr;
  buttonText: string;
  onSubmit: (updates: Record<string, string>) => void | Promise<void>;
  operationKey?: string;
  loadingLabel?: string;
}

interface FieldGroup {
  name: string;
  labelKey?: (typeof CONFIG_FIELD_GROUP_KEYS)[string];
  items: ConfigFieldDescriptor[];
}

function groupFields(fields: ConfigFieldDescriptor[]): FieldGroup[] {
  const groups = new Map<string, ConfigFieldDescriptor[]>();
  for (const item of fields) {
    const name = item.group || "";
    const items = groups.get(name) || [];
    items.push(item);
    groups.set(name, items);
  }
  return [...groups.entries()].map(([name, items]) => ({
    name,
    labelKey: CONFIG_FIELD_GROUP_KEYS[items[0]?.key || ""],
    items,
  }));
}

function collectConfigUpdates(form: HTMLFormElement, attr: ConfigAttr): Record<string, string> {
  const selector = attr === "yamlKey" ? "[data-yaml-key]" : "[data-env-key]";
  const updates: Record<string, string> = {};
  form
    .querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(selector)
    .forEach((control) => {
      const key = attr === "yamlKey" ? control.dataset.yamlKey : control.dataset.envKey;
      if (!key) return;
      const value = control.value;
      if (value === control.dataset.initial) return;
      if ((control as HTMLInputElement).type === "password" && !value) return;
      if (attr === "envKey" && value === "") return;
      updates[key] = value;
    });
  return updates;
}

export function ConfigForm({
  fields,
  attr,
  buttonText,
  onSubmit,
  operationKey,
  loadingLabel,
}: ConfigFormProps) {
  const { t } = useI18n();
  const loading = useStore((state) =>
    operationKey ? state.pendingOperations.includes(operationKey) : state.busy,
  );
  const [dirty, setDirty] = useState(false);

  if (!fields.length) {
    return <div className="muted">{t("admin.config.loading")}</div>;
  }

  const groups = groupFields(fields);

  return (
    <form
      className="config-fields-form"
      onChange={(event) => {
        setDirty(Object.keys(collectConfigUpdates(event.currentTarget, attr)).length > 0);
      }}
      onSubmit={(event) => {
        event.preventDefault();
        const updates = collectConfigUpdates(event.currentTarget, attr);
        if (!Object.keys(updates).length) return;
        void onSubmit(updates);
      }}
    >
      <div className="config-groups">
        {groups.map((group, index) => (
          // First two groups default open, mirroring the legacy `open: index < 2`.
          <details className="config-group" key={group.name} open={index < 2}>
            <summary>
              <span>{group.labelKey ? t(group.labelKey) : group.name || t("admin.config.group.configuration")}</span>
              <span className="nav__badge">{String(group.items.length)}</span>
            </summary>
            <div className="config-group__body">
              {group.items.map((item) => (
                <label className="config-field" key={item.key}>
                  <span className="config-field__label">
                    <strong>{CONFIG_FIELD_LABEL_KEYS[item.key] ? t(CONFIG_FIELD_LABEL_KEYS[item.key]) : item.label || item.key}</strong>
                    <span className="config-field__meta">
                      {item.defaulted ? <span className="config-field__source">{t("admin.config.defaultValue")}</span> : null}
                      <code>{item.key}</code>
                    </span>
                  </span>
                  <ConfigFieldControl item={item} attr={attr} />
                </label>
              ))}
            </div>
          </details>
        ))}
      </div>
      <div className="form-actions">
        <LoadingButton
          variant="primary"
          type="submit"
          disabled={!dirty}
          loading={loading}
          loadingLabel={loadingLabel || t("admin.common.saving")}
        >
          {buttonText}
        </LoadingButton>
      </div>
    </form>
  );
}
