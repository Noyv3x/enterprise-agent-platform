import { Button, Space } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { deleteAgentSchedule, loadAgentSchedule, loadAgentScheduleRuns, loadAgentSchedules, pauseAgentSchedule, resumeAgentSchedule, runAgentScheduleNow } from "../../data/scheduleActions";
import { toast } from "../../context/ToastContext";
import { intlLocale, useI18n } from "../../i18n";
import type { AgentSchedule, AgentScheduleRun } from "../../types";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { CapabilityHeader, ResourceList, ResourceRow, StatusMark, Notice, DataRegion, EmptyState, FactGrid, SplitDetail, Section } from "../ui/fieldwork";
import { formatScheduleDate, scheduleIsRunning, scheduleRuleLabel, scheduleRunStatusLabel, scheduleStateLabel } from "./scheduleFormat";
import "./scheduled-tasks.css";

const HISTORY_PAGE_SIZE = 20;
type Confirmation = { kind: "run" | "delete"; schedule: AgentSchedule } | null;
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function RunHistoryRow({run,timezone}:{run:AgentScheduleRun;timezone:string}) {
 const {t,locale}=useI18n(); const intl=intlLocale(locale);
 return <ResourceRow title={<code>#{run.id}</code>} status={<StatusMark tone={run.status === "succeeded" ? "success" : run.status === "failed" || run.status === "blocked" ? "danger" : "warning"}>{scheduleRunStatusLabel(run.status,t)}</StatusMark>}
 meta={<Space orientation="vertical"><span>{t("scheduledTasks.scheduledFor",{time:formatScheduleDate(run.scheduled_for,intl,timezone)})}</span>{run.started_at ? <span>{t("scheduledTasks.startedAt",{time:formatScheduleDate(run.started_at,intl,timezone)})}</span> : null}{run.finished_at ? <span>{t("scheduledTasks.finishedAt",{time:formatScheduleDate(run.finished_at,intl,timezone)})}</span> : null}</Space>}>
 {run.error ? <Notice tone="danger" title={run.error}/> : null}</ResourceRow>;
}

export function ScheduledTasksPanel() {
  const { t } = useI18n();
  const [schedules, setSchedules] = useState<AgentSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<AgentSchedule | null>(null);
  const [runs, setRuns] = useState<AgentScheduleRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [nextBeforeId, setNextBeforeId] = useState<number | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const listController = useRef<AbortController | null>(null);
  const listRequestVersion = useRef(0);
  const historyController = useRef<AbortController | null>(null);
  const historyRequestVersion = useRef(0);
  const loadMoreController = useRef<AbortController | null>(null);
  const selectedIdRef = useRef<number | null>(null);
  const mutationBusyRef = useRef(false);

  const refresh = useCallback(async () => {
    listController.current?.abort();
    const controller = new AbortController();
    const requestVersion = ++listRequestVersion.current;
    listController.current = controller;
    setLoading(true);
    setLoadError("");
    try {
      const result = await loadAgentSchedules(controller.signal);
      if (!controller.signal.aborted && listRequestVersion.current === requestVersion) {
        setSchedules(result.schedules || []);
      }
    } catch (error) {
      if (!controller.signal.aborted && listRequestVersion.current === requestVersion) {
        setLoadError(errorText(error));
      }
    } finally {
      if (listController.current === controller) {
        listController.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      listRequestVersion.current += 1;
      listController.current?.abort();
      listController.current = null;
    };
  }, [refresh]);

  const selectSchedule = useCallback((id: number | null) => {
    selectedIdRef.current = id;
    historyRequestVersion.current += 1;
    historyController.current?.abort();
    historyController.current = null;
    loadMoreController.current?.abort();
    loadMoreController.current = null;
    setDetail(null);
    setRuns([]);
    setHistoryLoading(false);
    setHistoryError("");
    setNextBeforeId(null);
    setSelectedId(id);
  }, []);

  useEffect(() => () => {
    selectedIdRef.current = null;
    historyRequestVersion.current += 1;
    historyController.current?.abort();
    historyController.current = null;
    loadMoreController.current?.abort();
    loadMoreController.current = null;
  }, []);

  useEffect(() => {
    historyController.current?.abort();
    loadMoreController.current?.abort();
    loadMoreController.current = null;
    if (selectedId == null) {
      setDetail(null);
      setRuns([]);
      setHistoryLoading(false);
      setHistoryError("");
      setNextBeforeId(null);
      return;
    }
    const controller = new AbortController();
    const requestVersion = ++historyRequestVersion.current;
    historyController.current = controller;
    setHistoryLoading(true);
    setHistoryError("");
    void Promise.all([
      loadAgentSchedule(selectedId, controller.signal),
      loadAgentScheduleRuns(selectedId, HISTORY_PAGE_SIZE, undefined, controller.signal),
    ]).then(([detailResult, historyResult]) => {
      if (controller.signal.aborted
        || historyRequestVersion.current !== requestVersion
        || selectedIdRef.current !== selectedId) return;
      setDetail(detailResult.schedule);
      setSchedules((current) => current.map((item) =>
        item.id === detailResult.schedule.id ? detailResult.schedule : item,
      ));
      setRuns(historyResult.runs || []);
      setNextBeforeId(historyResult.next_before_id ?? null);
    }).catch((error) => {
      if (!controller.signal.aborted
        && historyRequestVersion.current === requestVersion
        && selectedIdRef.current === selectedId) {
        setHistoryError(errorText(error));
      }
    }).finally(() => {
      if (historyController.current === controller) {
        historyController.current = null;
        if (selectedIdRef.current === selectedId) setHistoryLoading(false);
      }
    });
    return () => controller.abort();
  }, [historyRevision, selectedId]);

  const invalidateListRefresh = useCallback(() => {
    listRequestVersion.current += 1;
    listController.current?.abort();
    listController.current = null;
    setLoading(false);
  }, []);

  const invalidateHistoryRefresh = useCallback(() => {
    historyRequestVersion.current += 1;
    historyController.current?.abort();
    historyController.current = null;
    loadMoreController.current?.abort();
    loadMoreController.current = null;
    setHistoryLoading(false);
  }, []);

  const replaceSchedule = useCallback((schedule: AgentSchedule) => {
    setSchedules((current) => current.map((item) => item.id === schedule.id ? schedule : item));
    setDetail((current) => current?.id === schedule.id ? schedule : current);
  }, []);

  const mutate = useCallback(async (
    key: string,
    work: () => Promise<{ schedule: AgentSchedule }>,
    successMessage: string,
  ) => {
    if (mutationBusyRef.current) return;
    mutationBusyRef.current = true;
    invalidateListRefresh();
    invalidateHistoryRefresh();
    setBusyKey(key);
    setMutationError("");
    try {
      const result = await work();
      replaceSchedule(result.schedule);
      toast(successMessage, { type: "ok", title: t("toast.complete") });
    } catch (error) {
      setMutationError(errorText(error));
    } finally {
      mutationBusyRef.current = false;
      setBusyKey("");
    }
  }, [invalidateHistoryRefresh, invalidateListRefresh, replaceSchedule, t]);

  const handlePause = (schedule: AgentSchedule) => void mutate(
    `pause:${schedule.id}`,
    () => pauseAgentSchedule(schedule.id),
    t("scheduledTasks.pauseSuccess"),
  );
  const handleResume = (schedule: AgentSchedule) => void mutate(
    `resume:${schedule.id}`,
    () => resumeAgentSchedule(schedule.id),
    t("scheduledTasks.resumeSuccess"),
  );
  const handleRunNow = (schedule: AgentSchedule) => void mutate(
    `run:${schedule.id}`,
    async () => {
      const result = await runAgentScheduleNow(schedule.id);
      if (selectedIdRef.current === schedule.id) {
        setRuns((current) => [result.run, ...current.filter((item) => item.id !== result.run.id)]);
      }
      return result;
    },
    t("scheduledTasks.runNowSuccess"),
  );
  const handleDelete = async (schedule: AgentSchedule) => {
    if (mutationBusyRef.current) return;
    mutationBusyRef.current = true;
    invalidateListRefresh();
    invalidateHistoryRefresh();
    setBusyKey(`delete:${schedule.id}`);
    setMutationError("");
    try {
      await deleteAgentSchedule(schedule.id);
      setSchedules((current) => current.filter((item) => item.id !== schedule.id));
      if (selectedIdRef.current === schedule.id) selectSchedule(null);
      toast(t("scheduledTasks.deleteSuccess"), { type: "ok", title: t("toast.complete") });
    } catch (error) {
      setMutationError(errorText(error));
    } finally {
      mutationBusyRef.current = false;
      setBusyKey("");
    }
  };

  const loadMore = async () => {
    if (!detail || nextBeforeId == null || historyLoading) return;
    loadMoreController.current?.abort();
    const controller = new AbortController();
    const scheduleId = detail.id;
    const beforeId = nextBeforeId;
    loadMoreController.current = controller;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const result = await loadAgentScheduleRuns(
        scheduleId,
        HISTORY_PAGE_SIZE,
        beforeId,
        controller.signal,
      );
      if (controller.signal.aborted
        || loadMoreController.current !== controller
        || selectedIdRef.current !== scheduleId) return;
      setRuns((current) => [...current, ...(result.runs || []).filter((run) => !current.some((item) => item.id === run.id))]);
      setNextBeforeId(result.next_before_id ?? null);
    } catch (error) {
      if (!controller.signal.aborted
        && loadMoreController.current === controller
        && selectedIdRef.current === scheduleId) {
        setHistoryError(errorText(error));
      }
    } finally {
      if (loadMoreController.current === controller) {
        loadMoreController.current = null;
        if (selectedIdRef.current === scheduleId) setHistoryLoading(false);
      }
    }
  };

  const { locale } = useI18n();
  const intl = intlLocale(locale);
  const taskRow = (schedule: AgentSchedule, detailed = false) => {
    if (!detailed && selectedId === schedule.id) return <ResourceRow key={schedule.id} title={schedule.name} selected />;
    return <ResourceRow key={schedule.id}
    title={<h3>{schedule.name}</h3>} description={detailed ? <p className="wf-schedule-prompt">{schedule.prompt}</p> : scheduleRuleLabel(schedule.schedule,schedule.timezone,intl,t)}
    selected={selectedId === schedule.id}
    status={<StatusMark tone={scheduleIsRunning(schedule) || schedule.state === "active" ? "success" : schedule.state === "paused" ? "warning" : "neutral"}>{scheduleIsRunning(schedule) && schedule.last_run ? scheduleRunStatusLabel(schedule.last_run.status,t) : scheduleStateLabel(schedule.state,t)}</StatusMark>}
    meta={<Space orientation="vertical"><span>{t("scheduledTasks.timezone",{timezone:schedule.timezone})}</span><span>{formatScheduleDate(schedule.next_run_at,intl,schedule.timezone) || t("scheduledTasks.noNextRun")}</span>{schedule.last_run ? <span>{t("scheduledTasks.lastRun",{time:formatScheduleDate(schedule.last_run.scheduled_for,intl,schedule.timezone)})} · {scheduleRunStatusLabel(schedule.last_run.status,t)}</span> : null}<span>{t(schedule.delivery === "chat_and_telegram" ? "scheduledTasks.delivery.telegram" : "scheduledTasks.delivery.chat")}</span></Space>}
    actions={<Space wrap>{!detailed ? <Button disabled={!!busyKey || loading} onClick={() => {if(selectedId === schedule.id)setHistoryRevision(value=>value+1);else selectSchedule(schedule.id);}}>{t("scheduledTasks.history")}</Button> : null}
      {schedule.state === "active" ? <Button disabled={!!busyKey || loading || (detailed && historyLoading)} onClick={() => handlePause(schedule)}>{t("scheduledTasks.pause")}</Button> : schedule.state === "paused" ? <Button disabled={!!busyKey || loading || (detailed && historyLoading)} onClick={() => handleResume(schedule)}>{t("scheduledTasks.resume")}</Button> : null}
      <Button disabled={!!busyKey || loading || (detailed && historyLoading)} onClick={() => setConfirmation({kind:"run",schedule})}>{t("scheduledTasks.runNow")}</Button><Button danger disabled={!!busyKey || loading || (detailed && historyLoading)} onClick={() => setConfirmation({kind:"delete",schedule})}>{t("scheduledTasks.delete")}</Button>
    </Space>}>
      {detailed ? <FactGrid columns={2} items={[{key:"id",label:t("scheduledTasks.idLabel"),value:schedule.id},{key:"rule",label:t("scheduledTasks.schedule"),value:scheduleRuleLabel(schedule.schedule,schedule.timezone,intl,t)},{key:"next",label:t("scheduledTasks.nextRunLabel"),value:formatScheduleDate(schedule.next_run_at,intl,schedule.timezone)||t("scheduledTasks.noNextRun")},{key:"created",label:t("scheduledTasks.createdAtLabel"),value:formatScheduleDate(schedule.created_at,intl,schedule.timezone)},{key:"updated",label:t("scheduledTasks.updatedAtLabel"),value:formatScheduleDate(schedule.updated_at,intl,schedule.timezone)}]}/> : null}
    </ResourceRow>;
  };
  return <section className="wf-schedules" aria-label={t("scheduledTasks.title")}>
    <CapabilityHeader title={t("scheduledTasks.title")} description={t("scheduledTasks.emptyDetail")} actions={<Button disabled={loading || !!busyKey} onClick={() => void refresh()}>{t("scheduledTasks.refresh")}</Button>}/>
    {mutationError ? <Notice tone="danger" title={mutationError}/> : null}
    <SplitDetail detailOpen={selectedId != null} onBack={() => selectSchedule(null)} backLabel={t("scheduledTasks.back")}
      list={<DataRegion state={schedules.length ? "ready" : loading ? "loading" : loadError ? "error" : "empty"} loadingLabel={t("scheduledTasks.loading")} error={loadError} refreshing={loading && !!schedules.length} refreshingLabel={t("scheduledTasks.loading")} retry={<Button onClick={() => void refresh()}>{t("resource.retry")}</Button>} empty={<EmptyState title={t("scheduledTasks.empty")}/>}><ResourceList label={t("scheduledTasks.count",{count:schedules.length})}>{schedules.map(schedule=>taskRow(schedule))}</ResourceList></DataRegion>}
      detail={selectedId != null ? <Section title={detail ? t("scheduledTasks.historyFor",{name:detail.name}) : t("scheduledTasks.history")} actions={<Button disabled={historyLoading || !!busyKey} onClick={() => setHistoryRevision(value=>value+1)}>{t("scheduledTasks.refreshHistory")}</Button>}>
        <DataRegion state={detail ? "ready" : historyLoading ? "loading" : historyError ? "error" : "empty"} loadingLabel={t("scheduledTasks.loading")} error={historyError} refreshing={historyLoading && !!detail} refreshingLabel={t("scheduledTasks.loading")} retry={<Button onClick={() => setHistoryRevision(value=>value+1)}>{t("resource.retry")}</Button>}>
          {detail ? <><ResourceList>{taskRow(detail,true)}</ResourceList>{runs.length ? <ResourceList label={t("scheduledTasks.history")}>{runs.map(run=><RunHistoryRow key={run.id} run={run} timezone={detail.timezone}/>)}</ResourceList> : !historyLoading ? <EmptyState title={t("scheduledTasks.historyEmpty")} description={t("scheduledTasks.historyEmptyDetail")}/> : null}{nextBeforeId != null ? <Button disabled={historyLoading || !!busyKey} onClick={() => void loadMore()}>{t("scheduledTasks.loadMore")}</Button> : null}</> : null}
        </DataRegion>
      </Section> : null}/>
    {confirmation ? <ConfirmDialog danger={confirmation.kind === "delete"} title={t(confirmation.kind === "delete" ? "scheduledTasks.deleteConfirmTitle" : "scheduledTasks.runNowConfirmTitle")} message={t(confirmation.kind === "delete" ? "scheduledTasks.deleteConfirm" : "scheduledTasks.runNowConfirm",{name:confirmation.schedule.name})} confirmText={t(confirmation.kind === "delete" ? "scheduledTasks.delete" : "scheduledTasks.runNow")} onCancel={() => setConfirmation(null)} onConfirm={() => {const current=confirmation;setConfirmation(null);if(current.kind === "delete")void handleDelete(current.schedule);else handleRunNow(current.schedule);}}/> : null}
  </section>;
}
