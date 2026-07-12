/* <RawYamlForm/> — the raw config.yaml textarea sub-form of <HermesInternalConfig>
   (legacy renderHermesInternalConfig form (B), legacy-app.js:2482-2498). A single
   controlled textarea; on submit the parent PUTs { yaml_text }. The textarea
   re-seeds only when the incoming `value` prop actually changes (the post-save
   refetch returns the canonical yaml_text), so editing is never clobbered by an
   unrelated render. */

import { useEffect, useRef, useState } from "react";
import { useStore } from "../../../store/useStore";
import { useI18n } from "../../../i18n";

export interface RawYamlFormProps {
  value: string;
  onSubmit: (yamlText: string) => void;
}

export function RawYamlForm({ value, onSubmit }: RawYamlFormProps) {
  const { t } = useI18n();
  const busy = useStore((state) => state.busy);
  const [text, setText] = useState(value);
  const lastSeeded = useRef(value);

  useEffect(() => {
    if (value !== lastSeeded.current) {
      lastSeeded.current = value;
      setText(value);
    }
  }, [value]);

  return (
    <form
      className="raw-config-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(text);
      }}
    >
      <div className="section-label">{t("admin.config.hermesInternal.yamlFile")}</div>
      <textarea
        className="raw-config"
        spellCheck={false}
        aria-label={t("admin.config.hermesInternal.yamlAria")}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="form-actions">
        <button className="btn btn--primary" type="submit" disabled={busy}>
          <span>{t("admin.config.hermesInternal.saveYaml")}</span>
        </button>
      </div>
    </form>
  );
}
