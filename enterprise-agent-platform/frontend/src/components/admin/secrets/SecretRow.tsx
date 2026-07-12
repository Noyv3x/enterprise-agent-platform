/* <SecretRow/> — one platform-internal secret with an inline set form (legacy
   renderSecretsSettings per-row, legacy-app.js:2644-2660). The input is local
   controlled state; on submit PUT { value } then clear it + reload secrets.
   Empty value still posts (legacy parity). The "设置" button is intentionally NOT
   disabled while busy, matching the legacy markup (no `disabled` was set there).
   The aria-label ties the key name to the unlabeled password input. */

import { useState } from "react";
import { setSecret } from "../../../data/adminActions";
import { useStoreHandle } from "../../../store/useStore";
import type { Secret } from "../../../types";
import { Icon } from "../../common/Icon";
import { useI18n } from "../../../i18n";

export function SecretRow({ secret }: { secret: Secret }) {
  const { t } = useI18n();
  const store = useStoreHandle();
  const [value, setValue] = useState("");

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void setSecret(store, secret.key, value, () => setValue(""));
  };

  return (
    <div className="secret-row">
      <div className="secret-row__key">
        <Icon name="key" />
        <span className="secret-row__name">{secret.key}</span>
      </div>
      <span className="secret-row__val">{secret.configured ? secret.masked : t("admin.secrets.emptyValue")}</span>
      <form onSubmit={handleSubmit}>
        <input
          type="password"
          autoComplete="off"
          aria-label={secret.key}
          placeholder={secret.configured ? secret.masked : t("admin.common.notConfigured")}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button className="btn btn--sm" type="submit">
          {t("admin.secrets.set")}
        </button>
      </form>
    </div>
  );
}
