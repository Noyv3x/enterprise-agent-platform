/* <SecuritySettings/> — public-facing security config form and read-only status board.

   Numbers (session_ttl_seconds) are kept as STRING state and sent raw —
   the backend parses them; coercing to Number would change the payload. The
   session secret is never seeded (empty = keep existing) and clears after save.
   Form state re-seeds whenever the loaded securityConfig object changes (initial
   async load and the PUT response that replaces it) without clobbering
   in-progress typing. */

import { Button, Input, Switch } from "antd";
import { useEffect, useId, useState } from "react";
import { saveSecurityConfig } from "../../../data/adminActions";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { SecurityConfigValues } from "../../../types";
import { CardHead } from "../../common/CardHead";
import { Field } from "../../common/Field";
import { StatusBadge } from "../../common/StatusBadge";
import { AdminCard } from "../AdminCard";
import { useI18n } from "../../../i18n";
import { LANAccessSettings } from "./LANAccessSettings";

interface SecurityFormState {
  publicBaseUrl: string;
  trustedProxy: boolean;
  sessionTtl: string;
  sessionSecret: string;
}

function seedForm(security: SecurityConfigValues): SecurityFormState {
  return {
    publicBaseUrl: security.public_base_url || "",
    trustedProxy: !!security.trusted_proxy,
    sessionTtl: String(security.session_ttl_seconds || 7 * 24 * 60 * 60),
    sessionSecret: "",
  };
}

function StatusRow({ label, ok, value }: { label: string; ok: boolean; value: string }) {
  return (
    <div className="security-status__row">
      <span>{label}</span>
      <StatusBadge ok={ok} label={value} />
    </div>
  );
}

export function SecuritySettings() {
  const { t } = useI18n();
  const publicUrlId = useId();
  const publicUrlHintId = useId();
  const trustedProxyLabelId = useId();
  const trustedProxyHintId = useId();
  const sessionTtlId = useId();
  const sessionTtlHintId = useId();
  const sessionSecretId = useId();
  const sessionSecretHintId = useId();
  const store = useStoreHandle();
  const saving = useStore((state) => state.pendingOperations.includes("admin:security:save"));
  const securityConfig = useStore((state) => state.securityConfig);
  const security = securityConfig?.config || {};

  const [form, setForm] = useState<SecurityFormState>(() => seedForm(securityConfig?.config || {}));

  useEffect(() => {
    setForm(seedForm(securityConfig?.config || {}));
  }, [securityConfig]);

  const dirty = JSON.stringify(form) !== JSON.stringify(seedForm(securityConfig?.config || {}));

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void saveSecurityConfig(store, {
      public_base_url: form.publicBaseUrl,
      trusted_proxy: form.trustedProxy,
      session_ttl_seconds: form.sessionTtl,
      session_secret: form.sessionSecret,
    });
  };

  return (
    <div className="eap-security-settings-stack">
    <AdminCard className="config-form security-config">
      <CardHead
        title={t("admin.security.title")}
        icon="key"
        desc={t("admin.security.description")}
      />
      <form onSubmit={handleSubmit}>
        <div className="config-grid">
          <div className="field--full">
            <Field label={t("admin.security.publicUrl")}>
              <div className="field-stack">
                <Input
                  id={publicUrlId}
                  aria-label={t("admin.security.publicUrl")}
                  value={form.publicBaseUrl}
                  placeholder={t("admin.security.publicUrlPlaceholder")}
                  aria-describedby={publicUrlHintId}
                  onChange={(event) => setForm((prev) => ({ ...prev, publicBaseUrl: event.target.value }))}
                />
                <div className="field-help" id={publicUrlHintId}>
                  {t("admin.security.publicUrlHint")}
                </div>
              </div>
            </Field>
          </div>
          <div className="check-row field--full">
            <Switch
              checked={form.trustedProxy}
              aria-labelledby={trustedProxyLabelId}
              aria-describedby={trustedProxyHintId}
              onChange={(checked) => setForm((prev) => ({ ...prev, trustedProxy: checked }))}
            />
            <div className="check-row__text">
              <strong id={trustedProxyLabelId}>{t("admin.security.trustProxy")}</strong>
              <span id={trustedProxyHintId}>{t("admin.security.trustProxyHint")}</span>
            </div>
          </div>
          <Field label={t("admin.security.sessionTtl")}>
            <div className="field-stack">
              <Input
                id={sessionTtlId}
                aria-label={t("admin.security.sessionTtl")}
                type="number"
                min="60"
                max={String(30 * 24 * 60 * 60)}
                step="60"
                value={form.sessionTtl}
                aria-describedby={sessionTtlHintId}
                onChange={(event) => setForm((prev) => ({ ...prev, sessionTtl: event.target.value }))}
              />
              <div className="field-help" id={sessionTtlHintId}>{t("admin.security.sessionTtlHint")}</div>
            </div>
          </Field>
          <Field label={t("admin.security.rotateSecret")}>
            <div className="field-stack">
              <Input.Password
                id={sessionSecretId}
                aria-label={t("admin.security.rotateSecret")}
                autoComplete="off"
                placeholder={security.session_secret_configured ? t("admin.common.leaveBlank") : t("admin.security.secretPlaceholder")}
                value={form.sessionSecret}
                aria-describedby={sessionSecretHintId}
                onChange={(event) => setForm((prev) => ({ ...prev, sessionSecret: event.target.value }))}
              />
              <div className="field-help" id={sessionSecretHintId}>{t("admin.security.rotateSecretHint")}</div>
            </div>
          </Field>
        </div>
        <div className="form-actions">
          <Button
            type="primary"
            htmlType="submit"
            disabled={!dirty}
            loading={saving}
          >
            {t(saving ? "admin.common.saving" : "admin.security.save")}
          </Button>
        </div>
      </form>
      <div className="security-status">
        <StatusRow
          label={t("admin.security.secureCookie")}
          ok={!!security.secure_cookie_enabled}
          value={t(security.secure_cookie_enabled ? "admin.common.enabled" : "admin.common.disabled")}
        />
        <StatusRow
          label={t("admin.security.trustedProxy")}
          ok={!!security.trusted_proxy}
          value={t(security.trusted_proxy ? "admin.security.proxyTrusted" : "admin.security.proxyUntrusted")}
        />
        <StatusRow
          label={t("admin.security.defaultAdmin")}
          ok={!security.admin_default_password_active && !security.allow_default_admin_password}
          value={
            security.admin_default_password_active
              ? t("admin.security.currentlyUsable")
              : security.allow_default_admin_password
                ? t("admin.security.allowedAtStartup")
                : t("admin.common.disabled")
          }
        />
        <StatusRow
          label={t("admin.security.sessionSecret")}
          ok={!!security.session_secret_configured}
          value={t(security.session_secret_source === "env" ? "admin.security.fromEnv" : "admin.security.persisted")}
        />
        <StatusRow
          label={t("admin.security.listenAddress")}
          ok={Boolean(security.applied_host && security.applied_port)}
          value={`${security.applied_host || "-"}:${security.applied_port || "-"}`}
        />
        <StatusRow
          label={t("admin.security.bootstrapFile")}
          ok={!security.bootstrap_password_file_exists}
          value={t(security.bootstrap_password_file_exists ? "admin.security.exists" : "admin.security.notExists")}
        />
      </div>
    </AdminCard>
    <LANAccessSettings />
    </div>
  );
}
