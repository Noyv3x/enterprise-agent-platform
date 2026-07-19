/* <AutoUpdateConfig/> — GitHub-webhook/polling auto-update watcher config + a
   live status board (based on legacy renderAutoUpdateConfig, legacy-app.js:2364-2456).
   interval_seconds is kept as STRING state and sent raw; the webhook secret is
   never seeded (empty = keep) and clears via the post-save re-seed. Status polls
   without overwriting an in-progress form draft. The "立即检查" button is gated
   on the LIVE config.enabled (not the form draft). */

import { useEffect, useState } from "react";
import { checkAutoUpdateNow, saveAutoUpdateConfig } from "../../../data/adminActions";
import { loadAutoUpdateConfig } from "../../../data/loaders";
import { useStore, useStoreHandle } from "../../../store/useStore";
import { formatTime, formatTimestamp, shortSha } from "../../../utils/format";
import type { AutoUpdateConfigValues, AutoUpdateStatus } from "../../../types";
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

function updateStateLabel(
  t: ReturnType<typeof useI18n>["t"],
  status: AutoUpdateStatus,
): string {
  const state = String(status.state || status.phase || "");
  switch (state) {
    case "checking": return t("admin.updates.state.checking");
    case "waiting_for_tasks": return t("admin.updates.state.waiting");
    case "launching": return t("admin.updates.state.launching");
    case "updating": return t("admin.updates.state.updating");
    case "failed": return t("admin.updates.state.failed");
    case "idle": return t("admin.updates.idle");
    default:
      return status.in_progress
        ? t("admin.updates.checking")
        : status.update_started
          ? t("admin.updates.triggered")
          : status.update_available
            ? t("admin.updates.available")
            : t("admin.updates.idle");
  }
}

function updateTime(value: number | string | undefined): string {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return formatTime(numeric);
  return formatTimestamp(value);
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
  const updateState = updateStateLabel(t, status);
  const phase = status.state || status.phase || "";
  const clean = !status.dirty;
  const configFingerprint = JSON.stringify(config);

  const [form, setForm] = useState<AutoUpdateFormState>(() =>
    seedForm(autoUpdateConfig?.config || {}),
  );

  useEffect(() => {
    setForm(seedForm(config));
  }, [configFingerprint]);

  useEffect(() => {
    let stopped = false;
    let running = false;
    let timer: number | null = null;

    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer);
      if (stopped || document.hidden) return;
      const liveStatus = store.getState().autoUpdateConfig?.status;
      const livePhase = liveStatus?.state || liveStatus?.phase || "";
      const delay = ["checking", "waiting_for_tasks", "launching", "updating"].includes(livePhase)
        ? 2_000
        : 5_000;
      timer = window.setTimeout(() => void refresh(), delay);
    };
    const refresh = async () => {
      if (stopped || running || document.hidden) return;
      running = true;
      try {
        await loadAutoUpdateConfig(store);
      } catch {
        // The top-level update gate owns maintenance/reconnect feedback.
      } finally {
        running = false;
        schedule();
      }
    };
    const resume = () => {
      if (document.hidden) {
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
      } else {
        void refresh();
      }
    };

    document.addEventListener("visibilitychange", resume);
    schedule();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [store]);

  const dirty = JSON.stringify(form) !== JSON.stringify(seedForm(autoUpdateConfig?.config || {}));

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void saveAutoUpdateConfig(
      store,
      {
        enabled: form.enabled,
        interval_seconds: form.interval,
        remote: form.remote,
        branch: form.branch,
        webhook_secret: form.webhookSecret,
      },
      () => setForm((current) => ({ ...current, webhookSecret: "" })),
    );
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
        <UsageMetricTile label={t("admin.updates.activeTasks")} value={status.active_tasks ?? "-"} />
        <UsageMetricTile label={t("admin.updates.queuedTasks")} value={status.queued_tasks ?? "-"} />
        <UsageMetricTile label={t("admin.updates.protectedProcesses")} value={status.protected_processes ?? "-"} />
        <UsageMetricTile label={t("admin.updates.waitingSince")} value={updateTime(status.waiting_since) || "-"} />
        <UsageMetricTile label={t("admin.updates.worktree")} value={t(clean ? "admin.updates.clean" : "admin.updates.dirty")} />
        <UsageMetricTile label={t("admin.updates.currentRevision")} value={shortSha(status.current_revision)} />
        <UsageMetricTile label={t("admin.updates.remoteRevision")} value={shortSha(status.remote_revision)} />
        <UsageMetricTile label={t("admin.updates.lastCheck")} value={formatTime(Number(status.last_check_at) || undefined) || "-"} />
        <UsageMetricTile label={t("admin.updates.lastTrigger")} value={updateTriggerLabel(t, status.last_trigger)} />
      </div>
      {phase === "waiting_for_tasks" ? (
        <div className="notice">{t("admin.updates.waitingNotice")}</div>
      ) : null}
      {status.last_error ? <div className="notice notice--warn">{status.last_error}</div> : null}
      {status.dirty_summary ? <pre className="config-preview">{status.dirty_summary}</pre> : null}
    </section>
  );
}
