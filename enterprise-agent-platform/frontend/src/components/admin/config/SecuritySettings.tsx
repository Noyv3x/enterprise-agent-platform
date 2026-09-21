import { Button, Form, Input, Switch } from "antd";
import { useEffect, useState } from "react";
import { saveSecurityConfig } from "../../../data/adminActions";
import { useI18n } from "../../../i18n";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { SecurityConfigValues } from "../../../types";
import { FactGrid, FormFooter, FormGrid, Notice, Section } from "../../ui/fieldwork";
import { LANAccessSettings } from "./LANAccessSettings";

function seed(config: SecurityConfigValues) { return { url: config.public_base_url || "", proxy: !!config.trusted_proxy, ttl: String(config.session_ttl_seconds ?? 604800), secret: "" }; }
export function SecuritySettings() {
  const { t } = useI18n();
  const store = useStoreHandle();
  const data = useStore((state) => state.securityConfig);
  const saving = useStore((state) => state.pendingOperations.includes("admin:security:save"));
  const config = data?.config || {};
  const [draft, setDraft] = useState(() => seed(config));
  useEffect(() => setDraft(seed(data?.config || {})), [data]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(seed(config));
  const stateText = (value: boolean | undefined) => value === undefined ? t("admin.common.unknown") : t(value ? "admin.common.enabled" : "admin.common.disabled");
  return <>
    <Section title={t("admin.security.title")} description={t("admin.security.description")}>
      <Form layout="vertical" disabled={saving} onFinish={() => { if (dirty && !saving) void saveSecurityConfig(store, { public_base_url: draft.url, trusted_proxy: draft.proxy, session_ttl_seconds: draft.ttl, session_secret: draft.secret }); }}>
        <FormGrid>
          <Form.Item label={t("admin.security.publicUrl")} extra={t("admin.security.publicUrlHint")}><Input aria-label={t("admin.security.publicUrl")} placeholder={t("admin.security.publicUrlPlaceholder")} value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} /></Form.Item>
          <Form.Item label={t("admin.security.trustProxy")} extra={t("admin.security.trustProxyHint")}><Switch aria-label={t("admin.security.trustProxy")} checked={draft.proxy} onChange={(proxy) => setDraft({ ...draft, proxy })} /></Form.Item>
          <Form.Item label={t("admin.security.sessionTtl")} extra={t("admin.security.sessionTtlHint")}><Input aria-label={t("admin.security.sessionTtl")} type="number" min={60} max={2592000} step={60} value={draft.ttl} onChange={(e) => setDraft({ ...draft, ttl: e.target.value })} /></Form.Item>
          <Form.Item label={t("admin.security.rotateSecret")} extra={t("admin.security.rotateSecretHint")}><Input.Password aria-label={t("admin.security.rotateSecret")} autoComplete="new-password" placeholder={t("admin.security.secretPlaceholder")} value={draft.secret} onChange={(e) => setDraft({ ...draft, secret: e.target.value })} /></Form.Item>
        </FormGrid>
        <FormFooter><Button type="primary" htmlType="submit" loading={saving} disabled={!dirty || saving || (!!draft.secret && draft.secret.trim().length < 32)}>{t("admin.security.save")}</Button></FormFooter>
      </Form>
      {(data?.restart_required || data?.session_secret_restart_required) && <Notice tone="warning" title={t("admin.toast.restartRequired")}>{t(data.session_secret_restart_required ? "admin.toast.securitySecretRestart" : "admin.toast.securityRestart")}</Notice>}
      <FactGrid items={[
        { key: "cookie", label: t("admin.security.secureCookie"), value: stateText(config.secure_cookie_enabled) },
        { key: "proxy", label: t("admin.security.trustedProxy"), value: stateText(config.trusted_proxy) },
        { key: "admin", label: t("admin.security.defaultAdmin"), value: config.admin_default_password_active ? t("admin.security.currentlyUsable") : config.allow_default_admin_password ? t("admin.security.allowedAtStartup") : stateText(config.allow_default_admin_password) },
        { key: "secret", label: t("admin.security.sessionSecret"), value: config.session_secret_configured ? t(config.session_secret_source === "env" ? "admin.security.fromEnv" : "admin.security.persisted") : t("admin.common.notConfigured"), hint: config.session_secret_source },
        { key: "listen", label: t("admin.security.listenAddress"), value: config.applied_host && config.applied_port !== undefined ? `${config.applied_host}:${config.applied_port}` : t("admin.common.unknown") },
        { key: "bootstrap", label: t("admin.security.bootstrapFile"), value: config.bootstrap_password_file_exists === undefined ? t("admin.common.unknown") : t(config.bootstrap_password_file_exists ? "admin.security.exists" : "admin.security.notExists") },
      ]} />
    </Section>
    <LANAccessSettings />
  </>;
}
