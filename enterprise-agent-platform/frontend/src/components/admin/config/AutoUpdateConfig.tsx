import {
  Alert,
  Button,
  Descriptions,
  Input,
  Popconfirm,
  Progress,
  Space,
  Switch,
  Tag,
  Typography,
} from "antd";
import { useEffect, useId, useState } from "react";
import {
  checkAutoUpdateNow,
  runManagerOperation,
  saveAutoUpdateConfig,
} from "../../../data/adminActions";
import { loadAutoUpdateConfig } from "../../../data/loaders";
import { useI18n } from "../../../i18n";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { AutoUpdateConfigValues, AutoUpdateStatus, ManagerOperation } from "../../../types";
import { formatTimestamp, shortSha } from "../../../utils/format";
import { Field } from "../../common/Field";
import { Icon } from "../../common/Icon";
import { AdminCard } from "../AdminCard";

const ACTIVE_STATES = new Set(["waiting_for_tasks", "updating"]);

function stateLabel(t: ReturnType<typeof useI18n>["t"], status: AutoUpdateStatus): string {
  switch (status.state) {
    case "waiting_for_tasks": return t("admin.updates.state.waiting");
    case "updating": return t("admin.updates.state.updating");
    case "failed": return t("admin.updates.state.failed");
    default: return t("admin.updates.idle");
  }
}

function seedForm(config: AutoUpdateConfigValues) {
  return {
    enabled: config.enabled !== false,
    interval: String(config.interval_seconds || 300),
    manifestUrl: String(config.release_manifest_url || ""),
  };
}

function generation(value: string | undefined): string {
  return value ? value.slice(0, 18) : "-";
}

export function AutoUpdateConfig() {
  const { t } = useI18n();
  const store = useStoreHandle();
  const data = useStore((state) => state.autoUpdateConfig);
  const pending = useStore((state) => state.pendingOperations);
  const config = data?.config || {};
  const status = data?.status || {};
  const [form, setForm] = useState(() => seedForm(config));
  const fingerprint = JSON.stringify(config);
  const enabledLabelId = useId();

  useEffect(() => setForm(seedForm(config)), [fingerprint]);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const refresh = async () => {
      if (stopped || document.hidden) return;
      try {
        await loadAutoUpdateConfig(store);
      } catch {
        // UpdateGate owns manager/maintenance connectivity feedback.
      } finally {
        if (!stopped) {
          timer = window.setTimeout(
            () => void refresh(),
            ACTIVE_STATES.has(String(store.getState().autoUpdateConfig?.status?.state)) ? 2_000 : 8_000,
          );
        }
      }
    };
    timer = window.setTimeout(() => void refresh(), 8_000);
    const visibility = () => {
      if (timer) window.clearTimeout(timer);
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [store]);

  const saving = pending.includes("admin:updates:save");
  const checking = pending.includes("admin:updates:check");
  const operationRunning = pending.some((item) => item.startsWith("admin:updates:") && item !== "admin:updates:save" && item !== "admin:updates:check");
  const busy = status.state === "updating" || operationRunning;
  const dirty = JSON.stringify(form) !== JSON.stringify(seedForm(config));
  const services = Object.entries(status.services || {});
  const images = Object.entries(status.images || {});

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    void saveAutoUpdateConfig(store, {
      enabled: form.enabled,
      interval_seconds: form.interval,
      release_manifest_url: form.manifestUrl,
    });
  };

  const operate = (operation: Exclude<ManagerOperation, "install">) => {
    if (typeof status.manager_generation !== "number") return;
    void runManagerOperation(store, operation, status.manager_generation);
  };

  return (
    <div className="eap-manager-update-page">
      <AdminCard className="eap-manager-overview">
        <div className="eap-manager-overview__head">
          <div>
            <Typography.Title level={4}>{t("admin.updates.managerTitle")}</Typography.Title>
            <Typography.Paragraph type="secondary">{t("admin.updates.managerDescription")}</Typography.Paragraph>
          </div>
          <Tag color={status.state === "failed" ? "error" : status.state === "idle" ? "success" : "processing"}>
            {stateLabel(t, status)}
          </Tag>
        </div>

        {status.state === "updating" ? (
          <Progress percent={100} status="active" showInfo={false} aria-label={t("admin.updates.state.updating")} />
        ) : null}
        {status.state === "waiting_for_tasks" ? <Alert showIcon type="info" message={t("admin.updates.waitingNotice")} /> : null}
        {status.last_error ? (
          <Alert showIcon type="error" message={t("admin.updates.state.failed")} description={status.last_error} />
        ) : null}

        <Descriptions className="eap-manager-generations" size="small" column={{ xs: 1, sm: 2, lg: 3 }}>
          <Descriptions.Item label={t("admin.updates.currentGeneration")}>{generation(status.current_generation)}</Descriptions.Item>
          <Descriptions.Item label={t("admin.updates.targetGeneration")}>{generation(status.target_generation)}</Descriptions.Item>
          <Descriptions.Item label={t("admin.updates.previousGeneration")}>{generation(status.previous_generation)}</Descriptions.Item>
          <Descriptions.Item label={t("admin.updates.currentRevision")}>{shortSha(status.current_revision)}</Descriptions.Item>
          <Descriptions.Item label={t("admin.updates.targetRevision")}>{shortSha(status.remote_revision)}</Descriptions.Item>
          <Descriptions.Item label={t("admin.updates.phase")}>{status.phase || "-"}</Descriptions.Item>
          <Descriptions.Item label={t("admin.updates.operationId")} span={3}>
            <Typography.Text code copyable={!!status.operation_id}>{status.operation_id || "-"}</Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label={t("admin.updates.lastCheck")}>{formatTimestamp(status.last_check_at) || "-"}</Descriptions.Item>
          <Descriptions.Item label={t("admin.updates.activeTasks")}>{status.active_tasks ?? "-"}</Descriptions.Item>
          <Descriptions.Item label={t("admin.updates.queuedTasks")}>{status.queued_tasks ?? "-"}</Descriptions.Item>
        </Descriptions>

        {services.length ? (
          <div className="eap-manager-service-list" aria-label={t("admin.updates.services")}>
            {services.map(([name, service]) => (
              <Tag key={name} color={service.available === false ? "error" : "success"}>
                {name}: {service.state || (service.available === false ? "unavailable" : "ready")}
              </Tag>
            ))}
          </div>
        ) : null}

        {images.length ? (
          <details className="eap-manager-images">
            <summary>{t("admin.updates.imageDigests")}</summary>
            {images.map(([name, digest]) => <code key={name}>{name}: {digest}</code>)}
          </details>
        ) : null}

        <Space wrap className="eap-manager-actions">
          <Button loading={checking} disabled={busy} icon={<Icon name="refresh" size={15} />} onClick={() => void checkAutoUpdateNow(store)}>
            {t("admin.updates.checkNow")}
          </Button>
          <Button type="primary" disabled={busy || !status.update_available || typeof status.manager_generation !== "number"} onClick={() => operate("update")}>
            {t("admin.updates.updateNow")}
          </Button>
          <Popconfirm title={t("admin.updates.restartConfirm")} onConfirm={() => operate("restart")}>
            <Button disabled={busy || typeof status.manager_generation !== "number"}>{t("admin.updates.restart")}</Button>
          </Popconfirm>
          <Popconfirm title={t("admin.updates.rollbackConfirm")} onConfirm={() => operate("rollback")}>
            <Button disabled={busy || !status.previous_generation || typeof status.manager_generation !== "number"}>{t("admin.updates.rollback")}</Button>
          </Popconfirm>
          {status.state === "failed" ? (
            <Button danger disabled={operationRunning || typeof status.manager_generation !== "number"} onClick={() => operate("repair")}>{t("admin.updates.repair")}</Button>
          ) : null}
        </Space>
      </AdminCard>

      <AdminCard className="config-form">
        <form onSubmit={save}>
          <div className="config-grid">
            <div className="check-row field--full">
              <Switch checked={form.enabled} aria-labelledby={enabledLabelId} onChange={(enabled) => setForm((current) => ({ ...current, enabled }))} />
              <div className="check-row__text">
                <strong id={enabledLabelId}>{t("admin.updates.enableWatcher")}</strong>
                <span>{t("admin.updates.enableWatcherHint")}</span>
              </div>
            </div>
            <Field label={t("admin.updates.interval")}>
              <Input type="number" min="30" max="86400" value={form.interval} onChange={(event) => setForm((current) => ({ ...current, interval: event.target.value }))} />
            </Field>
            <Field label={t("admin.updates.channel")}>
              <Input value={config.release_channel || "main"} disabled />
            </Field>
            <div className="field--full">
              <Field label={t("admin.updates.manifestUrl")}>
                <Input value={form.manifestUrl} placeholder="https://…/main.json" onChange={(event) => setForm((current) => ({ ...current, manifestUrl: event.target.value }))} />
              </Field>
            </div>
          </div>
          <div className="form-actions">
            <Button type="primary" htmlType="submit" disabled={!dirty || busy} loading={saving}>{t("admin.updates.save")}</Button>
          </div>
        </form>
      </AdminCard>
    </div>
  );
}
