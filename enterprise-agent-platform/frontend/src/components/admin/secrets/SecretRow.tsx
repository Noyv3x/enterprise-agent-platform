import { Button, Input, Field } from "../../ui/beautiful";
import { useState } from "react";
import { setSecret } from "../../../data/adminActions";
import { useI18n } from "../../../i18n";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { Secret } from "../../../types";
import { FormFooter, ResourceRow, StatusMark } from "../../ui/beautiful";

export function SecretRow({ secret }: { secret: Secret }) {
  const { t } = useI18n();
  const store = useStoreHandle();
  const setting = useStore((state) => state.pendingOperations.includes(`admin:secrets:set:${secret.key}`));
  const [value, setValue] = useState("");
  return <ResourceRow title={secret.key} meta={secret.masked || t("admin.secrets.emptyValue")} status={<StatusMark tone={secret.configured ? "success" : "neutral"}>{t(secret.configured ? "admin.common.enabled" : "admin.common.notConfigured")}</StatusMark>}>
    <form onSubmit={(event) => { event.preventDefault(); if (value && !setting) void setSecret(store, secret.key, value, () => setValue("")); }}><Field><Input type="password" aria-label={secret.key} autoComplete="new-password" value={value} disabled={setting} placeholder={t("admin.common.leaveBlank")} onChange={(e) => setValue(e.target.value)} /></Field>
    <FormFooter><Button  type="submit" loading={setting} disabled={!value || setting}>{t("admin.secrets.set")}</Button></FormFooter></form>
  </ResourceRow>;
}
