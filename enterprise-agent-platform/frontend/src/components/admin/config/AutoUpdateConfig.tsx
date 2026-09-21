import { Button, Input, Switch, Field } from "../../ui/beautiful";
import { useEffect, useRef, useState } from "react";
import { checkAutoUpdateNow, runManagerOperation, saveAutoUpdateConfig } from "../../../data/adminActions";
import { loadAutoUpdateConfig } from "../../../data/loaders";
import { useConfirm } from "../../../hooks/useConfirm";
import { useI18n } from "../../../i18n";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { AutoUpdateConfigValues, ManagerOperation } from "../../../types";
import { formatTimestamp } from "../../../utils/format";
import { FactGrid, FormFooter, FormGrid, Notice, ResourceList, ResourceRow, Section, StatusMark } from "../../ui/beautiful";

const SERVICES = ["platform", "agent-runtime", "camofox", "searxng", "firecrawl-playwright", "firecrawl-redis", "firecrawl-rabbitmq", "firecrawl-postgres", "firecrawl-api"];
const STATES: Record<string, true> = { idle: true, waiting_for_tasks: true, updating: true, failed: true };
function seed(config: AutoUpdateConfigValues) { return { enabled: config.enabled !== false, interval: String(config.interval_seconds ?? 300), manifest: config.release_manifest_url || "" }; }

export function AutoUpdateConfig() {
  const { t } = useI18n();
  const store = useStoreHandle();
  const { confirm, dialog } = useConfirm();
  const data = useStore((state) => state.autoUpdateConfig);
  const pending = useStore((state) => state.pendingOperations);
  const config = data?.config || {};
  const status = data?.status || {};
  const [draft, setDraft] = useState(() => seed(config));
  const [pollFailed, setPollFailed] = useState(false);
  const fingerprint = JSON.stringify(config);
  useEffect(() => setDraft(seed(config)), [fingerprint]);
  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    let timer: number | undefined;
    const refresh = async () => {
      if (stopped || document.hidden || inFlight) return;
      inFlight = true;
      try { await loadAutoUpdateConfig(store); if (!stopped) setPollFailed(false); }
      catch { if (!stopped) setPollFailed(true); }
      finally {
        inFlight = false;
        if (!stopped && !document.hidden) timer = window.setTimeout(() => void refresh(), ["waiting_for_tasks", "updating"].includes(String(store.getState().autoUpdateConfig?.status.state)) ? 2000 : 8000);
      }
    };
    const visibility = () => { if (timer) window.clearTimeout(timer); if (!document.hidden) void refresh(); };
    timer = window.setTimeout(() => void refresh(), 8000);
    document.addEventListener("visibilitychange", visibility);
    return () => { stopped = true; if (timer) window.clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [store]);
  const available = !pollFailed && Number.isFinite(status.manager_generation) && STATES[String(status.state)] === true;
  const saving = pending.includes("admin:updates:save");
  const checking = pending.includes("admin:updates:check");
  const pendingMutation = pending.some((key) => key.startsWith("admin:updates:") || key === "admin:security:lan:save");
  const blocked = !available || status.in_progress === true || status.state === "updating" || status.state === "waiting_for_tasks" || pendingMutation;
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const dirty = JSON.stringify(draft) !== JSON.stringify(seed(config));
  const stateLabel = !available ? t("admin.updates.unavailable") : status.state === "idle" ? t("admin.updates.idle") : status.state === "failed" ? t("admin.updates.state.failed") : status.state === "updating" ? t("admin.updates.state.updating") : t("admin.updates.state.waiting");
  const operate = async (operation: Exclude<ManagerOperation, "install">) => {
    if (blocked || typeof status.manager_generation !== "number") return;
    const generation = status.manager_generation;
    if (operation === "restart" || operation === "rollback") {
      if (!await confirm(t(operation === "restart" ? "admin.updates.restartConfirm" : "admin.updates.rollbackConfirm"), { danger: true, confirmText: t(operation === "restart" ? "admin.updates.restart" : "admin.updates.rollback") })) return;
      const latest = store.getState().autoUpdateConfig?.status;
      if (blockedRef.current || !latest || latest.manager_generation !== generation || STATES[String(latest.state)] !== true || latest.in_progress || ["updating", "waiting_for_tasks"].includes(String(latest.state))) return;
    }
    void runManagerOperation(store, operation, generation);
  };
  return <>
    {dialog}
    <Notice tone={!available || status.state === "failed" ? "danger" : status.state === "idle" ? "neutral" : "info"} title={stateLabel}>
      {!available && t("admin.updates.unavailableHint")}
      {available && status.state === "waiting_for_tasks" && t("admin.updates.waitingNotice")}
      {status.phase && <div>{t("admin.updates.phase")}: {status.phase}</div>}
      {status.last_error && <div>{status.last_error}</div>}
      {status.state === "failed" && <div>{t("admin.updates.recoveryHint")}</div>}
    </Notice>
    <Section title={t("admin.updates.managerTitle")} description={t("admin.updates.managerDescription")}>
      <FactGrid columns={3} items={[
        { key: "current", label: t("admin.updates.currentGeneration"), value: status.current_generation || "—" },
        { key: "target", label: t("admin.updates.targetGeneration"), value: status.target_generation || "—" },
        { key: "previous", label: t("admin.updates.previousGeneration"), value: status.previous_generation || "—" },
        { key: "commit", label: t("admin.updates.currentRevision"), value: status.current_revision || "—" },
        { key: "remote", label: t("admin.updates.targetRevision"), value: status.remote_revision || "—" },
        { key: "activated", label: t("admin.updates.currentActivatedAt"), value: formatTimestamp(status.last_successful_update_at || undefined) },
        { key: "checked", label: t("admin.updates.lastCheck"), value: formatTimestamp(status.last_check_at) },
        { key: "active", label: t("admin.updates.activeTasks"), value: status.active_tasks ?? "—" },
        { key: "queued", label: t("admin.updates.queuedTasks"), value: status.queued_tasks ?? "—" },
        { key: "operation", label: t("admin.updates.operationId"), value: status.operation_id || "—" },
        { key: "version", label: t("admin.updates.generationVersion"), value: status.manager_generation ?? "—" },
      ]} />
      <div className="bui-actions"><Button loading={checking} disabled={blocked} onClick={() => { if (!blocked) void checkAutoUpdateNow(store); }}>{t("admin.updates.checkNow")}</Button>
      <Button  variant="primary" disabled={blocked || !status.update_available} onClick={() => void operate("update")}>{t("admin.updates.updateNow")}</Button>
      <Button disabled={blocked} onClick={() => void operate("restart")}>{t("admin.updates.restart")}</Button>
      <Button  variant="danger" disabled={blocked || !status.previous_generation} onClick={() => void operate("rollback")}>{t("admin.updates.rollback")}</Button>
      {status.state === "failed" && <Button disabled={blocked} onClick={() => void operate("repair")}>{t("admin.updates.repair")}</Button>}</div>
    </Section>
    <Section title={t("admin.updates.enableWatcher")}>
      <form onSubmit={(event) => { event.preventDefault(); if (!blocked && dirty) void saveAutoUpdateConfig(store, { enabled: draft.enabled, interval_seconds: draft.interval, release_manifest_url: draft.manifest }); }}><FormGrid>
        <Field label={t("admin.updates.enableWatcher")} hint={t("admin.updates.enableWatcherHint")} ><Switch aria-label={t("admin.updates.enableWatcher")} checked={draft.enabled} disabled={blocked} onChange={(enabled) => setDraft({ ...draft, enabled })} /></Field>
        <Field label={t("admin.updates.interval")}><Input aria-label={t("admin.updates.interval")} type="number" min={30} max={86400} value={draft.interval} onChange={(e) => setDraft({ ...draft, interval: e.target.value })} /></Field>
        <Field label={t("admin.updates.manifestUrl")}><Input aria-label={t("admin.updates.manifestUrl")} value={draft.manifest} onChange={(e) => setDraft({ ...draft, manifest: e.target.value })} /></Field>
        <Field label={t("admin.updates.channel")}><span>{config.release_channel || "—"}</span></Field>
      </FormGrid>
      <FormFooter><Button  type="submit" loading={saving} disabled={!dirty || blocked}>{t("admin.updates.save")}</Button></FormFooter></form>
    </Section>
    <Section title={t("admin.updates.services")}><ResourceList>{Array.from(new Set([...SERVICES, ...Object.keys(status.services || {})])).map((name) => {
      const service = status.services?.[name];
      const ready = service?.available === true && ["running", "available", "healthy"].includes(service.state || "");
      const label = service?.state || t("admin.runtime.down");
      return <ResourceRow key={name} title={`${name}: ${label}`} status={<StatusMark tone={ready ? "success" : "warning"}>{ready ? t("admin.runtime.ready") : t("admin.runtime.down")}</StatusMark>} description={service?.error} />;
    })}</ResourceList></Section>
    {!!Object.keys(status.images || {}).length && <Section title={t("admin.updates.imageDigests")}><ResourceList>{Object.entries(status.images || {}).map(([name, digest]) => <ResourceRow key={name} title={name} description={<code>{digest}</code>} />)}</ResourceList></Section>}
  </>;
}
