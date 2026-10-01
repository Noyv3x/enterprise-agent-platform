import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from '../api';
import { Button } from '../components/ui/beautiful/atoms/Button';
import { ConfirmDialog, EmptyState, Icon, Notice, PageHeader, Sheet } from '../components/ui/beautiful/controls';
import { FilterChips } from '../components/ui/beautiful/primitives/FilterTable';
import LoadingState from '../components/ui/beautiful/primitives/LoadingState';
import TaskRows, { type TaskRow } from '../components/ui/beautiful/primitives/TaskRows';
import { useI18n } from '../i18n';
import { useWords } from '../words';
import { ScheduleForm } from './schedules/ScheduleForm';
import { ScheduleRuns } from './schedules/ScheduleRuns';
import { ruleLabel, runFailed, runStatusLabel, stateLabel } from './schedules/labels';
import { formatDate, isRunLive } from './schedules/model';
import type { Schedule } from './schedules/model';

/** While a run is queued or running, the list and history refresh on this cadence until it settles. */
const LIVE_REFRESH_MS = 5_000;

type Action = 'pause' | 'resume' | 'run-now' | 'delete';
type Filter = 'all' | 'active' | 'paused' | 'failed';

export function Schedules() {
  const w = useWords();
  const { locale } = useI18n();
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState<Filter>('all');
  const [form, setForm] = useState<{ schedule: Schedule | null } | null>(null);
  const [historyId, setHistoryId] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<{ schedule: Schedule; action: 'run-now' | 'delete' } | null>(null);
  const [busy, setBusy] = useState<{ id: number; action: Action } | null>(null);
  const actionPending = useRef(false);
  const [actionError, setActionError] = useState<{ id: number; message: string } | null>(null);
  const [runsRevision, setRunsRevision] = useState(0);

  /** `quiet` reloads in place (live refresh) without the loading state. */
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setLoadError('');
    try {
      const result = await request<{ schedules: Schedule[] }>('/api/schedules');
      setSchedules(result.schedules);
    } catch (failure) {
      setLoadError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const live = schedules?.some((schedule) => isRunLive(schedule.last_run)) ?? false;
  // Each quiet reload replaces `schedules`, which re-arms the timer until no run is live.
  useEffect(() => {
    if (!live) return;
    const timer = window.setTimeout(() => {
      void load(true);
      setRunsRevision((value) => value + 1);
    }, LIVE_REFRESH_MS);
    return () => window.clearTimeout(timer);
  }, [live, schedules, load]);

  const upsert = (schedule: Schedule) => setSchedules((current) => {
    const list = current ?? [];
    return list.some((item) => item.id === schedule.id) ? list.map((item) => item.id === schedule.id ? schedule : item) : [...list, schedule];
  });

  const act = async (schedule: Schedule, action: Action) => {
    // Serialize mutations across rows; one completion must not dismiss another action.
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy({ id: schedule.id, action });
    setActionError(null);
    try {
      if (action === 'delete') {
        await request<{ ok: true }>(`/api/schedules/${schedule.id}`, { method: 'DELETE' });
        setSchedules((current) => current?.filter((item) => item.id !== schedule.id) ?? null);
      } else {
        const result = await request<{ schedule: Schedule }>(`/api/schedules/${schedule.id}/${action}`, { method: 'POST', body: '{}' });
        upsert(result.schedule);
        if (action === 'run-now') setRunsRevision((value) => value + 1);
      }
      setConfirm(null);
    } catch (failure) {
      setActionError({ id: schedule.id, message: failure instanceof Error ? failure.message : String(failure) });
      setConfirm(null);
    } finally {
      setBusy(null);
      actionPending.current = false;
    }
  };

  const refresh = () => {
    void load();
    setRunsRevision((value) => value + 1);
  };

  const list = schedules ?? [];
  const failed = (schedule: Schedule) => runFailed(schedule.last_run?.status);
  const matches = (schedule: Schedule, key: Filter) => key === 'all' || (key === 'failed' ? failed(schedule) : schedule.state === key);
  const shown = list.filter((schedule) => matches(schedule, filter));
  const history = list.find((schedule) => schedule.id === historyId) ?? null;

  const rows: TaskRow[] = shown.map((schedule) => {
    const state = stateLabel(schedule.state, w);
    const last = schedule.last_run ? runStatusLabel(schedule.last_run.status, w) : null;
    const liveRun = isRunLive(schedule.last_run);
    const next = formatDate(schedule.next_run_at, locale, schedule.timezone);
    const rowBusy = busy?.id === schedule.id;
    const lastWhen = schedule.last_run ? formatDate(schedule.last_run.finished_at || schedule.last_run.started_at || schedule.last_run.scheduled_for, locale, schedule.timezone) : '';
    return {
      key: String(schedule.id),
      label: schedule.name,
      amount: next ? w(`Next ${next}`, `下次 ${next}`, `下次 ${next}`) : w('No upcoming run', '没有待运行', '沒有待執行'),
      status: liveRun ? 'running' : last ? last.badge : schedule.state === 'completed' ? 'done' : 'idle',
      pill: liveRun && last ? { tone: last.tone, label: last.label } : last && last.badge === 'failed' ? { tone: last.tone, label: last.label } : { tone: state.tone, label: state.label },
      details: [
        { label: w('Timing', '时间规则', '時間規則'), meta: ruleLabel(schedule.schedule, schedule.timezone, locale, w) },
        { label: w('Time zone', '时区', '時區'), meta: schedule.timezone },
        { label: w('Next run', '下次运行', '下次執行'), meta: next || w('None', '无', '無') },
        { label: w('Last result', '上次结果', '上次結果'), meta: last ? `${last.label}${lastWhen ? ` · ${lastWhen}` : ''}` : w('Not run yet', '尚未运行', '尚未執行') },
        ...(schedule.last_run?.error ? [{ label: w('Last error', '上次错误', '上次錯誤'), meta: schedule.last_run.error, wide: true }] : []),
        { label: w('Instructions', '指令', '指令'), meta: schedule.prompt, wide: true },
      ],
      children: <div className="mt-1.5 flex flex-col gap-2">
        {actionError?.id === schedule.id && <Notice tone="danger" title={w('That did not work', '操作未成功', '操作未成功')}>{actionError.message}</Notice>}
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={w(`Actions for ${schedule.name}`, `${schedule.name} 的操作`, `${schedule.name} 的操作`)}>
          <Button size="xs" disabled={!!busy} onClick={() => setForm({ schedule })}><Icon name="pencil" size={13} />{w('Edit', '编辑', '編輯')}</Button>
          <Button size="xs" disabled={!!busy} onClick={() => setConfirm({ schedule, action: 'run-now' })}><Icon name="play" size={13} />{w('Run now', '立即运行', '立即執行')}</Button>
          {schedule.state === 'active' && <Button size="xs" disabled={!!busy} onClick={() => void act(schedule, 'pause')}><Icon name="pause" size={13} />{rowBusy && busy?.action === 'pause' ? w('Pausing…', '正在暂停…', '正在暫停…') : w('Pause', '暂停', '暫停')}</Button>}
          {schedule.state === 'paused' && <Button size="xs" disabled={!!busy} onClick={() => void act(schedule, 'resume')}><Icon name="play" size={13} />{rowBusy && busy?.action === 'resume' ? w('Resuming…', '正在恢复…', '正在恢復…') : w('Resume', '恢复', '恢復')}</Button>}
          <Button size="xs" disabled={rowBusy} onClick={() => setHistoryId(schedule.id)}><Icon name="history" size={13} />{w('Run history', '运行记录', '執行記錄')}</Button>
          <Button size="xs" variant="quiet" className="ml-auto text-red-ink" disabled={!!busy} onClick={() => setConfirm({ schedule, action: 'delete' })}><Icon name="trash" size={13} />{w('Delete', '删除', '刪除')}</Button>
        </div>
      </div>,
    };
  });

  return <div className="flex min-h-0 flex-1 flex-col">
    <PageHeader
      title={w('Schedules', '定时任务', '排程任務')}
      description={w('Tasks your personal AI runs on its own, at a set time or on a repeating rhythm.', '个人 AI 按指定时间或固定节奏自动执行的任务。', '個人 AI 依指定時間或固定節奏自動執行的任務。')}
      actions={<>
        <Button size="sm" variant="quiet" disabled={loading} onClick={refresh} aria-label={w('Refresh', '刷新', '重新整理')}><Icon name="refresh" size={14} /></Button>
        <Button size="sm" variant="primary" disabled={!!busy} onClick={() => setForm({ schedule: null })}><Icon name="plus" size={14} />{w('New schedule', '新建定时任务', '新增排程任務')}</Button>
      </>}
    />
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex max-w-[880px] flex-col gap-2 p-4 sm:p-6">
        {loadError && <Notice tone="danger" title={w('Schedules could not be loaded', '无法加载定时任务', '無法載入排程任務')}
          action={<Button size="sm" onClick={refresh}>{w('Retry', '重试', '重試')}</Button>}>{loadError}</Notice>}
        {!schedules && loading && <LoadingState label={w('Loading schedules…', '正在加载定时任务…', '正在載入排程任務…')} />}
        {schedules && !list.length && <EmptyState icon="clock" title={w('No schedules yet', '还没有定时任务', '還沒有排程任務')}
          description={w('Have your personal AI do a task at a set time or on a repeating rhythm, such as a morning news digest.', '让个人 AI 在指定时间或按固定节奏完成工作，例如每天早上的新闻摘要。', '讓個人 AI 在指定時間或依固定節奏完成工作，例如每天早上的新聞摘要。')}
          action={<Button size="sm" variant="primary" onClick={() => setForm({ schedule: null })}><Icon name="plus" size={14} />{w('New schedule', '新建定时任务', '新增排程任務')}</Button>} />}
        {list.length > 0 && <>
          <FilterChips<Filter>
            label={w('Filter schedules', '筛选定时任务', '篩選排程任務')}
            value={filter}
            onChange={setFilter}
            filters={[
              { key: 'all', label: w('All', '全部', '全部'), count: list.length },
              { key: 'active', label: w('Active', '已启用', '已啟用'), tone: 'done', count: list.filter((schedule) => matches(schedule, 'active')).length },
              { key: 'paused', label: w('Paused', '已暂停', '已暫停'), tone: 'todo', count: list.filter((schedule) => matches(schedule, 'paused')).length },
              { key: 'failed', label: w('Failed', '失败', '失敗'), tone: 'failed', count: list.filter(failed).length },
            ]}
          />
          {rows.length
            ? <TaskRows variant="List" rows={rows} open={open} onToggleRow={(key, next) => setOpen((current) => ({ ...current, [key]: next }))}
                ariaLabel={w('Schedules', '定时任务', '排程任務')}
                labels={{ completed: w('Succeeded', '已完成', '已完成'), failed: w('Failed', '失败', '失敗') }} />
            : <p className="px-1 py-6 text-center text-[12.5px] text-ink-2">{w('No schedules in this view.', '此视图中没有定时任务。', '此檢視中沒有排程任務。')}</p>}
        </>}
      </div>
    </div>

    {form && <ScheduleForm schedule={form.schedule} onClose={() => setForm(null)} onSaved={(schedule) => {
      upsert(schedule);
      setOpen((current) => ({ ...current, [String(schedule.id)]: true }));
      setForm(null);
    }} />}

    {history && <Sheet open onClose={() => setHistoryId(null)} title={w('Run history', '运行记录', '執行記錄')} description={history.name}>
      <ScheduleRuns key={history.id} scheduleId={history.id} timezone={history.timezone} revision={runsRevision} />
    </Sheet>}

    {confirm && <ConfirmDialog
      open
      tone={confirm.action === 'delete' ? 'danger' : 'default'}
      title={confirm.action === 'delete'
        ? w(`Delete “${confirm.schedule.name}”?`, `删除“${confirm.schedule.name}”？`, `刪除「${confirm.schedule.name}」？`)
        : w(`Run “${confirm.schedule.name}” now?`, `立即运行“${confirm.schedule.name}”？`, `立即執行「${confirm.schedule.name}」？`)}
      description={confirm.action === 'delete'
        ? w('It stops running and its history is no longer shown.', '任务将停止运行，运行记录也不再显示。', '任務將停止執行，執行記錄也不再顯示。')
        : w('The instructions go to your personal AI right away; the regular timing is unchanged.', '指令会立即发送给个人 AI，原有的定时安排不变。', '指令會立即傳送給個人 AI，原有的排程不變。')}
      confirmLabel={confirm.action === 'delete' ? w('Delete', '删除', '刪除') : w('Run now', '立即运行', '立即執行')}
      busy={!!busy}
      onConfirm={() => void act(confirm.schedule, confirm.action)}
      onCancel={() => setConfirm(null)}
    />}
  </div>;
}
