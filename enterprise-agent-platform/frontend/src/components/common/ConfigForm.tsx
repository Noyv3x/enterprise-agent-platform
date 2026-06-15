/* <ConfigForm/> — the generic descriptor-driven config editor, ported from
   legacy renderConfigFieldsForm + groupedConfigFields + renderConfigField +
   collectConfigUpdates (legacy-app.js:2541-2641). Used by the Hermes/Cognee
   internal config pages (Phase 4d).

   The form is uncontrolled (each field carries a data-initial attribute);
   on submit we collect a CHANGED-ONLY diff via the DOM, preserving the legacy
   skip rules verbatim:
     - skip if the value equals its data-initial,
     - skip empty password fields (keep existing secret),
     - for env attrs, skip empty values entirely,
     - values are sent as strings (numbers are NOT coerced — backend parses).
   If the diff is empty the submit is a no-op (onSubmit is not called). */

import { useStore } from "../../store/useStore";
import type { ConfigFieldDescriptor } from "../../types";
import { ConfigFieldControl, type ConfigAttr } from "./ConfigFieldControl";

export interface ConfigFormProps {
  fields: ConfigFieldDescriptor[];
  attr: ConfigAttr;
  buttonText: string;
  onSubmit: (updates: Record<string, string>) => void | Promise<void>;
}

interface FieldGroup {
  name: string;
  items: ConfigFieldDescriptor[];
}

function groupFields(fields: ConfigFieldDescriptor[]): FieldGroup[] {
  const groups = new Map<string, ConfigFieldDescriptor[]>();
  for (const item of fields) {
    const name = item.group || "配置";
    const items = groups.get(name) || [];
    items.push(item);
    groups.set(name, items);
  }
  return [...groups.entries()].map(([name, items]) => ({ name, items }));
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

export function ConfigForm({ fields, attr, buttonText, onSubmit }: ConfigFormProps) {
  const busy = useStore((state) => state.busy);

  if (!fields.length) {
    return <div className="muted">正在读取配置…</div>;
  }

  const groups = groupFields(fields);

  return (
    <form
      className="config-fields-form"
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
              <span>{group.name}</span>
              <span className="nav__badge">{String(group.items.length)}</span>
            </summary>
            <div className="config-group__body">
              {group.items.map((item) => (
                <label className="config-field" key={item.key}>
                  <span className="config-field__label">
                    <strong>{item.label || item.key}</strong>
                    <span className="config-field__meta">
                      {item.defaulted ? <span className="config-field__source">默认值</span> : null}
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
        <button className="btn btn--primary" type="submit" disabled={busy}>
          <span>{buttonText}</span>
        </button>
      </div>
    </form>
  );
}
