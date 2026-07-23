/* <SecretRow/> — one platform-internal secret with an inline set form (legacy
   renderSecretsSettings per-row, legacy-app.js:2644-2660). The input is local
   controlled state; on submit PUT { value } then clear it + reload secrets.
   The save action becomes available after the local value changes and tracks
   only this secret's operation. The aria-label ties the key name to the
   unlabeled password input. */

import { Button, Form, Input } from "antd";
import { useState } from "react";
import { setSecret } from "../../../data/adminActions";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { Secret } from "../../../types";
import { Icon } from "../../common/Icon";
import { useI18n } from "../../../i18n";

export function SecretRow({ secret }: { secret: Secret }) {
  const { t } = useI18n();
  const store = useStoreHandle();
  const setting = useStore((state) =>
    state.pendingOperations.includes(`admin:secrets:set:${secret.key}`),
  );
  const [value, setValue] = useState("");

  const handleSubmit = () => {
    void setSecret(store, secret.key, value, () => setValue(""));
  };

  return (
    <div className="secret-row">
      <div className="secret-row__key">
        <Icon name="key" />
        <span className="secret-row__name">{secret.key}</span>
      </div>
      <span className="secret-row__val">{secret.configured ? secret.masked : t("admin.secrets.emptyValue")}</span>
      <Form onFinish={handleSubmit}>
        <Input.Password
          autoComplete="off"
          aria-label={secret.key}
          placeholder={secret.configured ? secret.masked : t("admin.common.notConfigured")}
          value={value}
          visibilityToggle={false}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button
          htmlType="submit"
          size="small"
          disabled={!value}
          loading={setting}
          aria-label={t(setting ? "admin.common.setting" : "admin.secrets.set")}
        >
          {t("admin.secrets.set")}
        </Button>
      </Form>
    </div>
  );
}
