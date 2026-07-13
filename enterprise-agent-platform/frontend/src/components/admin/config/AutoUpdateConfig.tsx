/* <AutoUpdateConfig/> — GitHub-webhook/polling auto-update watcher config + an
   on-demand status board (legacy renderAutoUpdateConfig, legacy-app.js:2364-2456).
   interval_seconds is kept as STRING state and sent raw; the webhook secret is
   never seeded (empty = keep) and clears via the post-save re-seed. The status is
   NOT live-polled — it only refreshes on save or "立即检查" (legacy parity). The
   "立即检查" button is gated on the LIVE config.enabled (not the form draft). */

import { useEffect, useState } from "react";
import { checkAutoUpdateNow, saveAutoUpdateConfig } from "../../../data/adminActions";
import { useStore, useStoreHandle } from "../../../store/useStore";
import { formatTime, shortSha } from "../../../utils/format";
import type { AutoUpdateConfigValues } from "../../../types";
import { CardHead } from "../../common/CardHead";
import { Field } from "../../common/Field";
import { Icon } from "../../common/Icon";
import { LoadingButton } from "../../common/LoadingButton";
import { StatusBadge } from "../../common/StatusBadge";
import { UsageMetricTile } from "../../common/UsageMetricTile";
import { useI18n } from "../../../i18n";

function updateTriggerLabel(t: ReturnType<typeof useI18n>["t"], trigger: string | undefined): string {
  switch (trigger) {
    case "startup": return t("admin.updates.trigger.startup");
    case "config": return t("admin.updates.trigger.config");
    case "manual": return t("admin.updates.trigger.manual");
    case "webhook": return t("admin.updates.trigger.webhook");
    case "poll": return t("admin.updates.trigger.poll");
    default: return trigger || "-";
  }
}

interface AutoUpdateFormState {
  enabled: boolean;
  interval: string;
  remote: string;
  branch: string;
  webhookSecret: string;
}

function seedForm(config: AutoUpdateConfigValues): AutoUpdateFormState {
  return {
    enabled: !!config.enabled,
    interval: String(config.interval_seconds || 30),
    remote: config.remote || "origin",
    branch: config.branch || "",
    webhookSecret: "",
  };
}

export function AutoUpdateConfig() {
  const { t } = useI18n();
  const store = useStoreHandle();
  const saving = useStore((state) => state.pendingOperations.includes("admin:updates:save"));
  const checking = useStore((state) => state.pendingOperations.includes("admin:updates:check"));
  const autoUpdateConfig = useStore((state) => state.autoUpdateConfig);
  const config = autoUpdateConfig?.config || {};
  const status = autoUpdateConfig?.status || {};
  const webhookUrl = config.webhook_url || t("admin.updates.webhookPlaceholder");
  const updateState = status.in_progress
    ? t("admin.updates.checking")
    : status.update_started
      ? t("admin.updates.triggered")
      : status.update_available
        ? t("admin.updates.available")
        : t("admin.updates.idle");
  const clean = !status.dirty;

  const [form, setForm] = useState<AutoUpdateFormState>(() =>
    seedForm(autoUpdateConfig?.config || {}),
  );

  useEffect(() => {
    setForm(seedForm(autoUpdateConfig?.config || {}));
  }, [autoUpdateConfig]);

  const dirty = JSON.stringify(form) !== JSON.stringify(seedForm(autoUpdateConfig?.config || {}));

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void saveAutoUpdateConfig(store, {
      enabled: form.enabled,
      interval_seconds: form.interval,
      remote: form.remote,
      branch: form.branch,
      webhook_secret: form.webhookSecret,
    });
  };

  return (
    <section className="card config-form">
      <CardHead
        title={t("admin.updates.title")}
        icon="refresh"
        desc={t("admin.updates.description")}
        extra={<StatusBadge ok={!!config.enabled} label={t(config.enabled ? "admin.common.enabled" : "admin.common.disabled")} />}
      />
      <form onSubmit={handleSubmit}>
        <div className="config-grid">
          <label className="check-row">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => setForm((prev) => ({ ...prev, enabled: event.target.checked }))}
            />
            <div className="check-row__text">
              <strong>{t("admin.updates.enableWatcher")}</strong>
              <span>{t("admin.updates.enableWatcherHint")}</span>
            </div>
          </label>
          <Field label={t("admin.updates.interval")}>
            <input
              type="number"
              min="5"
              max="3600"
              step="1"
              value={form.interval}
              onChange={(event) => setForm((prev) => ({ ...prev, interval: event.target.value }))}
            />
          </Field>
          <Field label={t("admin.updates.remote")}>
            <input
              value={form.remote}
              placeholder={t("admin.updates.remotePlaceholder")}
              onChange={(event) => setForm((prev) => ({ ...prev, remote: event.target.value }))}
            />
          </Field>
          <Field label={t("admin.updates.branch")}>
            <input
              value={form.branch}
              placeholder={t("admin.updates.branchPlaceholder")}
              onChange={(event) => setForm((prev) => ({ ...prev, branch: event.target.value }))}
            />
          </Field>
          <div className="field--full">
            <Field label={t("admin.updates.webhookSecret")}>
              <input
                type="password"
                autoComplete="off"
                placeholder={config.webhook_secret_configured ? t("admin.common.keepUnchanged") : t("admin.updates.secretPlaceholder")}
                value={form.webhookSecret}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, webhookSecret: event.target.value }))
                }
              />
            </Field>
          </div>
          <div className="field--full field-stack">
            <span className="field-help">{t("admin.updates.webhookUrl")}</span>
            <code className="mono">{webhookUrl}</code>
          </div>
        </div>
        <div className="form-actions">
          <LoadingButton
            variant="primary"
            type="submit"
            disabled={!dirty}
            loading={saving}
            loadingLabel={t("admin.common.saving")}
          >
            {t("admin.updates.save")}
          </LoadingButton>
          <LoadingButton
            type="button"
            disabled={!config.enabled}
            loading={checking}
            loadingLabel={t("admin.common.checking")}
            onClick={() => void checkAutoUpdateNow(store)}
          >
            <Icon name="refresh" size={15} />
            <span>{t("admin.updates.checkNow")}</span>
          </LoadingButton>
        </div>
      </form>
      <div className="metric-grid metric-grid--compact">
        <UsageMetricTile label={t("admin.updates.status")} value={updateState} />
        <UsageMetricTile label={t("admin.updates.worktree")} value={t(clean ? "admin.updates.clean" : "admin.updates.dirty")} />
        <UsageMetricTile label={t("admin.updates.currentRevision")} value={shortSha(status.current_revision)} />
        <UsageMetricTile label={t("admin.updates.remoteRevision")} value={shortSha(status.remote_revision)} />
        <UsageMetricTile label={t("admin.updates.lastCheck")} value={formatTime(Number(status.last_check_at) || undefined) || "-"} />
        <UsageMetricTile label={t("admin.updates.lastTrigger")} value={updateTriggerLabel(t, status.last_trigger)} />
      </div>
      {status.last_error ? <div className="notice notice--warn">{status.last_error}</div> : null}
      {status.dirty_summary ? <pre className="config-preview">{status.dirty_summary}</pre> : null}
    </section>
  );
}
