/* <ConfigFieldControl/> — port of legacy configFieldControl (legacy-app.js:
   2586-2625). Renders the uncontrolled input/select/textarea for one config
   descriptor, carrying its data-{yaml,env}-key + data-initial attributes so the
   parent <ConfigForm> can collect a changed-only diff on submit.

   Value rules preserved verbatim:
   - boolean → select with ""/"true"/"false"; shown value derived from item.value.
   - options → select seeded only when configured/defaulted.
   - json → textarea, spellcheck off.
   - else → text/number/password input; secret inputs never echo a value and use
     the masked placeholder when configured. */

import type { ConfigFieldDescriptor } from "../../types";
import { useI18n } from "../../i18n";
import { CONFIG_FIELD_OPTION_KEYS } from "../../i18n/messages/admin";

export type ConfigAttr = "yamlKey" | "envKey";

export interface ConfigFieldControlProps {
  item: ConfigFieldDescriptor;
  attr: ConfigAttr;
}

export function ConfigFieldControl({ item, attr }: ConfigFieldControlProps) {
  const { t } = useI18n();
  // The data-* attribute name and its dataset key the diff selector matches on.
  const dataKeyProp =
    attr === "yamlKey" ? { "data-yaml-key": item.key } : { "data-env-key": item.key };
  const hasDisplayValue = !!item.configured || !!item.defaulted;

  if (item.kind === "boolean") {
    const initial = hasDisplayValue
      ? String(item.value === true || String(item.value).toLowerCase() === "true")
      : "";
    return (
      <select {...dataKeyProp} data-initial={initial} defaultValue={initial}>
        <option value="">{t("admin.config.unset")}</option>
        <option value="true">{t("admin.config.boolean.true")}</option>
        <option value="false">{t("admin.config.boolean.false")}</option>
      </select>
    );
  }

  if (item.options?.length) {
    const raw = hasDisplayValue ? String(item.value ?? "") : "";
    // Legacy set <select>.value first then read data-initial BACK from the live DOM
    // value, which the browser coerces to "" when the value isn't a real option.
    // Clamp the same way so data-initial agrees with the rendered value and an
    // out-of-list stored value isn't mis-detected as a changed field on submit.
    const initial = item.options.some((option) => String(option) === raw) ? raw : "";
    return (
      <select {...dataKeyProp} data-initial={initial} defaultValue={initial}>
        <option value="">{t("admin.config.unset")}</option>
        {item.options.map((option) => (
          <option key={option} value={option}>
            {CONFIG_FIELD_OPTION_KEYS[`${item.key}:${option}`]
              ? t(CONFIG_FIELD_OPTION_KEYS[`${item.key}:${option}`])
              : option}
          </option>
        ))}
      </select>
    );
  }

  if (item.kind === "json") {
    const initial = hasDisplayValue ? String(item.value ?? "") : "";
    return <textarea {...dataKeyProp} spellCheck={false} data-initial={initial} defaultValue={initial} />;
  }

  const rawInitial = !item.secret && hasDisplayValue ? String(item.value ?? "") : "";
  const type = item.secret ? "password" : item.kind === "number" ? "number" : "text";
  // A type=number input rejects (→ "") a non-numeric value in the browser; legacy
  // captured data-initial from that normalized value, so match it here to avoid a
  // spurious changed-field diff that would blank the key on the next save.
  const initial =
    type === "number" && rawInitial !== "" && !Number.isFinite(Number(rawInitial)) ? "" : rawInitial;
  const placeholder = item.secret && item.configured ? item.masked : "";
  return (
    <input
      {...dataKeyProp}
      type={type}
      autoComplete="off"
      placeholder={placeholder}
      data-initial={initial}
      defaultValue={initial}
    />
  );
}
