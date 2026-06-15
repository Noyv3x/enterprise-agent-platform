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
import { StatusBadge } from "../../common/StatusBadge";
import { UsageMetricTile } from "../../common/UsageMetricTile";

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
  const store = useStoreHandle();
  const busy = useStore((state) => state.busy);
  const autoUpdateConfig = useStore((state) => state.autoUpdateConfig);
  const config = autoUpdateConfig?.config || {};
  const status = autoUpdateConfig?.status || {};
  const webhookUrl = config.webhook_url || "启用后自动生成 webhook URL";
  const updateState = status.in_progress
    ? "检查中"
    : status.update_started
      ? "已触发更新"
      : status.update_available
        ? "发现更新"
        : "待命";
  const clean = !status.dirty;

  const [form, setForm] = useState<AutoUpdateFormState>(() =>
    seedForm(autoUpdateConfig?.config || {}),
  );

  useEffect(() => {
    setForm(seedForm(autoUpdateConfig?.config || {}));
  }, [autoUpdateConfig]);

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
        title="自动更新监听"
        icon="refresh"
        desc="常驻监听上游分支；GitHub webhook 可秒级触发，轮询作为兜底。"
        extra={<StatusBadge ok={!!config.enabled} label={config.enabled ? "已启用" : "未启用"} />}
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
              <strong>启用常驻监听</strong>
              <span>收到 webhook 或轮询发现上游更新后自动执行 deploy.sh update</span>
            </div>
          </label>
          <Field label="轮询间隔（秒）">
            <input
              type="number"
              min="5"
              max="3600"
              step="1"
              value={form.interval}
              onChange={(event) => setForm((prev) => ({ ...prev, interval: event.target.value }))}
            />
          </Field>
          <Field label="Git remote">
            <input
              value={form.remote}
              placeholder="origin"
              onChange={(event) => setForm((prev) => ({ ...prev, remote: event.target.value }))}
            />
          </Field>
          <Field label="分支">
            <input
              value={form.branch}
              placeholder="留空使用当前分支"
              onChange={(event) => setForm((prev) => ({ ...prev, branch: event.target.value }))}
            />
          </Field>
          <div className="field--full">
            <Field label="Webhook Secret">
              <input
                type="password"
                autoComplete="off"
                placeholder={config.webhook_secret_configured ? "保持不变" : "至少 16 位 secret"}
                value={form.webhookSecret}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, webhookSecret: event.target.value }))
                }
              />
            </Field>
          </div>
          <div className="field--full field-stack">
            <span className="field-help">GitHub Webhook URL</span>
            <code className="mono">{webhookUrl}</code>
          </div>
        </div>
        <div className="form-actions">
          <button className="btn btn--primary" type="submit" disabled={busy}>
            <span>保存自动更新配置</span>
          </button>
          <button
            className="btn"
            type="button"
            disabled={busy || !config.enabled}
            onClick={() => void checkAutoUpdateNow(store)}
          >
            <Icon name="refresh" size={15} />
            <span>立即检查</span>
          </button>
        </div>
      </form>
      <div className="metric-grid metric-grid--compact">
        <UsageMetricTile label="状态" value={updateState} />
        <UsageMetricTile label="工作树" value={clean ? "干净" : "有本地改动"} />
        <UsageMetricTile label="当前版本" value={shortSha(status.current_revision)} />
        <UsageMetricTile label="远端版本" value={shortSha(status.remote_revision)} />
        <UsageMetricTile label="最近检查" value={formatTime(Number(status.last_check_at) || undefined) || "-"} />
        <UsageMetricTile label="最近触发" value={status.last_trigger || "-"} />
      </div>
      {status.last_error ? <div className="notice notice--warn">{status.last_error}</div> : null}
      {status.dirty_summary ? <pre className="config-preview">{status.dirty_summary}</pre> : null}
    </section>
  );
}
