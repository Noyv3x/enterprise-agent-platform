import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteAgentSchedule,
  loadAgentSchedule,
  loadAgentScheduleRuns,
  loadAgentSchedules,
  pauseAgentSchedule,
  resumeAgentSchedule,
  runAgentScheduleNow,
} from "../../data/scheduleActions";
import { toast } from "../../context/ToastContext";
import { intlLocale, useI18n } from "../../i18n";
import { cx } from "../../lib/cx";
import type { AgentSchedule, AgentScheduleRun } from "../../types";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { EmptyState } from "../common/EmptyState";
import { Icon } from "../common/Icon";
import { InlineAlert } from "../common/InlineAlert";
import { Spinner } from "../common/Spinner";
import {
  formatScheduleDate,
  scheduleIsRunning,
  scheduleRuleLabel,
  scheduleRunStatusLabel,
  scheduleStateLabel,
} from "./scheduleFormat";

const HISTORY_PAGE_SIZE = 20;

type Confirmation =
  | { kind: "run"; schedule: AgentSchedule }
  | { kind: "delete"; schedule: AgentSchedule }
  | null;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function taskTone(schedule: AgentSchedule): "ok" | "warn" | "muted" {
  if (scheduleIsRunning(schedule) || schedule.state === "active") return "ok";
  return schedule.state === "paused" ? "warn" : "muted";
}

function runTone(status: string): "ok" | "warn" | "error" | "muted" {
  if (status === "succeeded") return "ok";
  if (status === "failed" || status === "blocked") return "error";
  if (status === "queued" || status === "running" || status === "needs_review") return "warn";
  return "muted";
}

function TaskStatus({ schedule }: { schedule: AgentSchedule }) {
  const { t } = useI18n();
  const running = scheduleIsRunning(schedule);
  const label = running && schedule.last_run
    ? scheduleRunStatusLabel(schedule.last_run.status, t)
    : scheduleStateLabel(schedule.state, t);
  return (
    <span className={cx("schedule-status", `is-${taskTone(schedule)}`)}>
      <span className={cx("dot", running && "dot--pulse")} aria-hidden="true" />
      {label}
    </span>
  );
}

interface ScheduleCardProps {
  schedule: AgentSchedule;
  busy: boolean;
  onHistory?: () => void;
  onPause: () => void;
  onResume: () => void;
  onRunNow: () => void;
  onDelete: () => void;
}

function ScheduleCard({
  schedule,
  busy,
  onHistory,
  onPause,
  onResume,
  onRunNow,
  onDelete,
}: ScheduleCardProps) {
  const { t, locale } = useI18n();
  const intl = intlLocale(locale);
  const next = formatScheduleDate(schedule.next_run_at, intl, schedule.timezone);
  const last = formatScheduleDate(schedule.last_run?.scheduled_for, intl, schedule.timezone);

  return (
    <article className="schedule-card">
      <header className="schedule-card__head">
        <div>
          <h3>{schedule.name}</h3>
          <TaskStatus schedule={schedule} />
        </div>
        <span className="schedule-card__id">#{schedule.id}</span>
      </header>
      <p className="schedule-card__prompt" title={schedule.prompt}>{schedule.prompt}</p>
      <dl className="schedule-card__facts">
        <div>
          <dt>{t("scheduledTasks.schedule")}</dt>
          <dd>{scheduleRuleLabel(schedule.schedule, schedule.timezone, intl, t)}</dd>
        </div>
        <div>
          <dt>{t("scheduledTasks.nextRunLabel")}</dt>
          <dd>{next || t("scheduledTasks.noNextRun")}</dd>
        </div>
      </dl>
      <div className="schedule-card__meta">
        <span>{t("scheduledTasks.timezone", { timezone: schedule.timezone })}</span>
        {last && schedule.last_run ? (
          <span>
            {t("scheduledTasks.lastRun", { time: last })} · {scheduleRunStatusLabel(schedule.last_run.status, t)}
          </span>
        ) : null}
        <span>
          {schedule.delivery === "chat_and_telegram"
            ? t("scheduledTasks.delivery.telegram")
            : t("scheduledTasks.delivery.chat")}
        </span>
      </div>
      <footer className="schedule-card__actions">
        {onHistory ? (
          <button className="btn btn--sm" type="button" disabled={busy} onClick={onHistory}>
            <Icon name="barChart" size={14} />
            <span>{t("scheduledTasks.history")}</span>
          </button>
        ) : null}
        {schedule.state === "active" ? (
          <button className="btn btn--sm" type="button" disabled={busy} onClick={onPause}>
            {t("scheduledTasks.pause")}
          </button>
        ) : schedule.state === "paused" ? (
          <button className="btn btn--sm" type="button" disabled={busy} onClick={onResume}>
            {t("scheduledTasks.resume")}
          </button>
        ) : null}
        <button className="btn btn--sm" type="button" disabled={busy} onClick={onRunNow}>
          <Icon name="send" size={14} />
          <span>{t("scheduledTasks.runNow")}</span>
        </button>
        <button className="btn btn--sm btn--danger" type="button" disabled={busy} onClick={onDelete}>
          <Icon name="trash" size={14} />
          <span>{t("scheduledTasks.delete")}</span>
        </button>
      </footer>
    </article>
  );
}

function RunHistoryRow({ run, timezone }: { run: AgentScheduleRun; timezone: string }) {
  const { t, locale } = useI18n();
  const intl = intlLocale(locale);
  return (
    <li className="schedule-run">
      <div className="schedule-run__head">
        <span className={cx("schedule-run__status", `is-${runTone(run.status)}`)}>
          <span className={cx("dot", run.status === "running" && "dot--pulse")} aria-hidden="true" />
          {scheduleRunStatusLabel(run.status, t)}
        </span>
        <span className="schedule-run__id">#{run.id}</span>
      </div>
      <div className="schedule-run__times">
        <span>{t("scheduledTasks.scheduledFor", { time: formatScheduleDate(run.scheduled_for, intl, timezone) })}</span>
        {run.started_at ? <span>{t("scheduledTasks.startedAt", { time: formatScheduleDate(run.started_at, intl, timezone) })}</span> : null}
        {run.finished_at ? <span>{t("scheduledTasks.finishedAt", { time: formatScheduleDate(run.finished_at, intl, timezone) })}</span> : null}
      </div>
      {run.error ? <p className="schedule-run__error">{run.error}</p> : null}
    </li>
  );
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
    if (busyKey) return;
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
      setBusyKey("");
    }
  }, [busyKey, invalidateHistoryRefresh, invalidateListRefresh, replaceSchedule, t]);

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
    if (busyKey) return;
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

  const card = (schedule: AgentSchedule, showHistory = true) => (
    <ScheduleCard
      key={schedule.id}
      schedule={schedule}
      busy={!!busyKey}
      onHistory={showHistory ? () => {
        if (selectedId === schedule.id) setHistoryRevision((value) => value + 1);
        else selectSchedule(schedule.id);
      } : undefined}
      onPause={() => handlePause(schedule)}
      onResume={() => handleResume(schedule)}
      onRunNow={() => setConfirmation({ kind: "run", schedule })}
      onDelete={() => setConfirmation({ kind: "delete", schedule })}
    />
  );

  return (
    <section className="scheduled-tasks" aria-label={t("scheduledTasks.title")}>
      {mutationError ? <InlineAlert variant="error">{mutationError}</InlineAlert> : null}
      {selectedId != null ? (
        <div className="schedule-history">
          <div className="schedule-panel__toolbar">
            <button className="btn btn--sm" type="button" onClick={() => selectSchedule(null)}>
              <span aria-hidden="true">←</span>
              <span>{t("scheduledTasks.back")}</span>
            </button>
            <span>{detail ? t("scheduledTasks.historyFor", { name: detail.name }) : t("scheduledTasks.history")}</span>
            <button
              className="icon-btn"
              type="button"
              disabled={historyLoading || !!busyKey}
              aria-label={t("scheduledTasks.refreshHistory")}
              title={t("scheduledTasks.refreshHistory")}
              onClick={() => setHistoryRevision((value) => value + 1)}
            >
              <Icon name="refresh" size={14} cls={historyLoading ? "spin" : undefined} />
            </button>
          </div>
          {historyError ? (
            <InlineAlert
              variant="error"
              action={<button className="btn btn--sm" type="button" onClick={() => setHistoryRevision((value) => value + 1)}>{t("resource.retry")}</button>}
            >
              {historyError}
            </InlineAlert>
          ) : null}
          {historyLoading && !detail ? (
            <div className="schedule-panel__loading" role="status">
              <Spinner size={20} />
              <span>{t("scheduledTasks.loading")}</span>
            </div>
          ) : detail ? (
            <>
              {card(detail, false)}
              {runs.length ? (
                <ol className="schedule-runs">
                  {runs.map((run) => <RunHistoryRow key={run.id} run={run} timezone={detail.timezone} />)}
                </ol>
              ) : !historyLoading ? (
                <EmptyState icon="barChart" title={t("scheduledTasks.historyEmpty")} text={t("scheduledTasks.historyEmptyDetail")} />
              ) : null}
              {historyLoading && runs.length ? <div className="schedule-panel__more"><Spinner size={16} /></div> : null}
              {nextBeforeId != null ? (
                <button className="btn btn--sm schedule-panel__load-more" type="button" disabled={historyLoading} onClick={() => void loadMore()}>
                  {t("scheduledTasks.loadMore")}
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : (
        <>
          <div className="schedule-panel__toolbar">
            <span>{t("scheduledTasks.count", { count: schedules.length })}</span>
            <button className="btn btn--sm" type="button" disabled={loading || !!busyKey} onClick={() => void refresh()}>
              <Icon name="refresh" size={14} cls={loading ? "spin" : undefined} />
              <span>{t("scheduledTasks.refresh")}</span>
            </button>
          </div>
          {loadError ? (
            <InlineAlert
              variant="error"
              title={t("scheduledTasks.loadFailed")}
              action={<button className="btn btn--sm" type="button" onClick={() => void refresh()}>{t("resource.retry")}</button>}
            >
              {loadError}
            </InlineAlert>
          ) : null}
          {loading && !schedules.length ? (
            <div className="schedule-panel__loading" role="status">
              <Spinner size={20} />
              <span>{t("scheduledTasks.loading")}</span>
            </div>
          ) : schedules.length ? (
            <div className="schedule-list">{schedules.map((schedule) => card(schedule))}</div>
          ) : !loadError ? (
            <EmptyState icon="calendar" title={t("scheduledTasks.empty")} text={t("scheduledTasks.emptyDetail")} />
          ) : null}
        </>
      )}
      {confirmation ? (
        <ConfirmDialog
          danger={confirmation.kind === "delete"}
          title={confirmation.kind === "delete" ? t("scheduledTasks.deleteConfirmTitle") : t("scheduledTasks.runNowConfirmTitle")}
          message={confirmation.kind === "delete"
            ? t("scheduledTasks.deleteConfirm", { name: confirmation.schedule.name })
            : t("scheduledTasks.runNowConfirm", { name: confirmation.schedule.name })}
          confirmText={confirmation.kind === "delete" ? t("scheduledTasks.delete") : t("scheduledTasks.runNow")}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            const current = confirmation;
            setConfirmation(null);
            if (current.kind === "delete") void handleDelete(current.schedule);
            else handleRunNow(current.schedule);
          }}
        />
      ) : null}
    </section>
  );
}
