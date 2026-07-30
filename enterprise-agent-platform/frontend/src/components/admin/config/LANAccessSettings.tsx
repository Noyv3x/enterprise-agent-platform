import { Alert, Button, Input, Switch, Tag, Typography } from "antd";
import { useEffect, useId, useState } from "react";
import { saveLANAccessConfig } from "../../../data/adminActions";
import { useI18n } from "../../../i18n";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { AutoUpdateConfigValues } from "../../../types";
import { CardHead } from "../../common/CardHead";
import { Field } from "../../common/Field";
import { AdminCard } from "../AdminCard";

interface LANFormState {
  enabled: boolean;
  listen: string;
  directCIDRs: string;
  trustedIngressCIDRs: string;
}

function seedForm(config: AutoUpdateConfigValues): LANFormState {
  return {
    enabled: !!config.lan_enabled,
    listen: config.lan_listen || "127.0.0.1:8081",
    directCIDRs: (config.direct_access_cidrs || []).join("\n"),
    trustedIngressCIDRs: (config.trusted_ingress_cidrs || []).join("\n"),
  };
}

function parseCIDRs(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function LANAccessSettings() {
  const { t } = useI18n();
  const store = useStoreHandle();
  const config = useStore((state) => state.autoUpdateConfig?.config || null);
  const saving = useStore((state) => state.pendingOperations.includes("admin:security:lan:save"));
  const enabledLabelId = useId();
  const enabledHintId = useId();
  const [form, setForm] = useState<LANFormState>(() => seedForm(config || {}));

  useEffect(() => setForm(seedForm(config || {})), [config]);

  if (!config) {
    return null;
  }

  const dirty = JSON.stringify(form) !== JSON.stringify(seedForm(config));
  const save = (event: React.FormEvent) => {
    event.preventDefault();
    void saveLANAccessConfig(store, {
      lan_enabled: form.enabled,
      lan_listen: form.listen.trim(),
      direct_access_cidrs: parseCIDRs(form.directCIDRs),
      trusted_ingress_cidrs: parseCIDRs(form.trustedIngressCIDRs),
    });
  };

  return (
    <AdminCard className="config-form security-config eap-lan-access-config">
      <CardHead
        title={t("admin.security.lanTitle")}
        icon="server"
        desc={t("admin.security.lanDescription")}
      />
      <div className="eap-lan-access-config__status">
        <Typography.Text type="secondary">{t("admin.security.lanRuntimeStatus")}</Typography.Text>
        <Tag color={config.lan_error ? (config.lan_active ? "warning" : "error") : config.lan_active ? "success" : "default"}>
          {t(config.lan_error
            ? config.lan_active
              ? "admin.security.lanActivePrevious"
              : "admin.security.lanUnavailable"
            : config.lan_active
              ? "admin.security.lanActive"
              : "admin.security.lanInactive")}
        </Tag>
      </div>
      {config.lan_error ? <Alert showIcon type={config.lan_active ? "warning" : "error"} message={t(config.lan_active ? "admin.security.lanApplyRejected" : "admin.security.lanBindError")} /> : null}
      {form.enabled ? <Alert showIcon type="warning" message={t("admin.security.lanPlaintextRisk")} /> : null}
      <form onSubmit={save}>
        <div className="config-grid">
          <div className="check-row field--full">
            <Switch
              checked={form.enabled}
              aria-labelledby={enabledLabelId}
              aria-describedby={enabledHintId}
              onChange={(enabled) => setForm((previous) => ({ ...previous, enabled }))}
            />
            <div className="check-row__text">
              <strong id={enabledLabelId}>{t("admin.security.lanEnable")}</strong>
              <span id={enabledHintId}>{t("admin.security.lanEnableHint")}</span>
            </div>
          </div>
          <div className="field--full">
            <Field label={t("admin.security.lanListen")}>
              <div className="field-stack">
                <Input
                  aria-label={t("admin.security.lanListen")}
                  value={form.listen}
                  placeholder="192.168.1.10:8081"
                  disabled={!form.enabled}
                  onChange={(event) => setForm((previous) => ({ ...previous, listen: event.target.value }))}
                />
                <div className="field-help">{t("admin.security.lanListenHint")}</div>
              </div>
            </Field>
          </div>
          <Field label={t("admin.security.lanDirectCIDRs")}>
            <div className="field-stack">
              <Input.TextArea
                aria-label={t("admin.security.lanDirectCIDRs")}
                autoSize={{ minRows: 3, maxRows: 7 }}
                value={form.directCIDRs}
                disabled={!form.enabled}
                onChange={(event) => setForm((previous) => ({ ...previous, directCIDRs: event.target.value }))}
              />
              <div className="field-help">{t("admin.security.lanDirectCIDRsHint")}</div>
            </div>
          </Field>
          <Field label={t("admin.security.lanTrustedIngressCIDRs")}>
            <div className="field-stack">
              <Input.TextArea
                aria-label={t("admin.security.lanTrustedIngressCIDRs")}
                autoSize={{ minRows: 3, maxRows: 7 }}
                value={form.trustedIngressCIDRs}
                onChange={(event) => setForm((previous) => ({ ...previous, trustedIngressCIDRs: event.target.value }))}
              />
              <div className="field-help">{t("admin.security.lanTrustedIngressCIDRsHint")}</div>
            </div>
          </Field>
        </div>
        <div className="form-actions">
          <Button type="primary" htmlType="submit" disabled={!dirty} loading={saving}>
            {t(saving ? "admin.common.saving" : "admin.security.lanSave")}
          </Button>
        </div>
      </form>
    </AdminCard>
  );
}
