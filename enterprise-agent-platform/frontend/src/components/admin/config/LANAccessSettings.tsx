import { Button, Input, Switch, Field, Textarea } from "../../ui/beautiful";
import { useEffect, useState } from "react";
import { saveLANAccessConfig } from "../../../data/adminActions";
import { useI18n } from "../../../i18n";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { AutoUpdateConfigValues } from "../../../types";
import { FormFooter, FormGrid, Notice, Section, StatusMark } from "../../ui/beautiful";

function seed(config: AutoUpdateConfigValues) { return { enabled: !!config.lan_enabled, listen: config.lan_listen || "127.0.0.1:8081", direct: (config.direct_access_cidrs || []).join("\n"), ingress: (config.trusted_ingress_cidrs || []).join("\n") }; }
function cidrs(value: string) { return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean); }
export function LANAccessSettings() {
  const { t } = useI18n();
  const store = useStoreHandle();
  const data = useStore((state) => state.autoUpdateConfig);
  const pending = useStore((state) => state.pendingOperations);
  const config = data?.config;
  const [draft, setDraft] = useState(() => seed(config || {}));
  useEffect(() => setDraft(seed(config || {})), [config]);
  if (!config) return null;
  const available = Number.isFinite(data?.status.manager_generation) && ["idle", "waiting_for_tasks", "updating", "failed"].includes(String(data?.status.state));
  const saving = pending.includes("admin:security:lan:save");
  const blocked = !available || data?.status.in_progress === true || ["waiting_for_tasks", "updating"].includes(String(data?.status.state)) || pending.some((key) => key === "admin:security:lan:save" || key.startsWith("admin:updates:"));
  const dirty = JSON.stringify(draft) !== JSON.stringify(seed(config));
  const listener = !available ? t("admin.security.lanUnavailable") : config.lan_error ? t(config.lan_active ? "admin.security.lanActivePrevious" : "admin.security.lanUnavailable") : config.lan_active === true ? t("admin.security.lanActive") : config.lan_active === false ? t("admin.security.lanInactive") : t("admin.security.lanUnavailable");
  return <Section title={t("admin.security.lanTitle")} description={t("admin.security.lanDescription")}>
    <StatusMark tone={available && config.lan_active && !config.lan_error ? "success" : "warning"}>{listener}</StatusMark>
    {!available && <Notice tone="danger" title={t("admin.updates.unavailable")} >{t("admin.updates.unavailableHint")}</Notice>}
    {config.lan_error && <Notice tone="warning" title={t(config.lan_active ? "admin.security.lanApplyRejected" : "admin.security.lanBindError")} />}
    <form onSubmit={(event) => { event.preventDefault(); if (!blocked && dirty) void saveLANAccessConfig(store, { lan_enabled: draft.enabled, lan_listen: draft.listen.trim(), direct_access_cidrs: cidrs(draft.direct), trusted_ingress_cidrs: cidrs(draft.ingress) }); }}><fieldset disabled={blocked}><FormGrid>
      <Field label={t("admin.security.lanEnable")} hint={t("admin.security.lanEnableHint")} ><Switch aria-label={t("admin.security.lanEnable")} checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} /></Field>
      <Field label={t("admin.security.lanListen")} hint={t("admin.security.lanListenHint")} ><Input aria-label={t("admin.security.lanListen")} value={draft.listen} disabled={blocked || !draft.enabled} onChange={(e) => setDraft({ ...draft, listen: e.target.value })} /></Field>
      <Field label={t("admin.security.lanDirectCIDRs")} hint={t("admin.security.lanDirectCIDRsHint")} ><Textarea aria-label={t("admin.security.lanDirectCIDRs")} rows={3} value={draft.direct} disabled={blocked || !draft.enabled} onChange={(e) => setDraft({ ...draft, direct: e.target.value })} /></Field>
      <Field label={t("admin.security.lanTrustedIngressCIDRs")} hint={t("admin.security.lanTrustedIngressCIDRsHint")} ><Textarea aria-label={t("admin.security.lanTrustedIngressCIDRs")} rows={3} value={draft.ingress} onChange={(e) => setDraft({ ...draft, ingress: e.target.value })} /></Field>
    </FormGrid>
    {draft.enabled && <Notice tone="warning" title={t("admin.security.lanPlaintextRisk")} />}
    <FormFooter><Button  type="submit" loading={saving} disabled={!dirty || blocked}>{t("admin.security.lanSave")}</Button></FormFooter></fieldset></form>
  </Section>;
}
