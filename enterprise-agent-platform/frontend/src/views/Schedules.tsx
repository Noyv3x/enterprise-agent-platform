import { Button, Popconfirm } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { request } from '../api';
import { DataRegion, EmptyState, FactGrid, Glyph, Notice, PageHeader, PageLayout, ResourceList, ResourceRow, Section, SplitDetail, StatusMark } from '../components/ui/fieldwork';
import { useI18n } from '../i18n';
import { useWords } from '../words';
import { ScheduleForm } from './schedules/ScheduleForm';
import { ScheduleRuns } from './schedules/ScheduleRuns';
import { ruleLabel, runStatusLabel, stateLabel } from './schedules/labels';
import { formatDate, isRunLive } from './schedules/model';
import type { Schedule } from './schedules/model';
import './schedules/schedules.css';

/** While a run is queued or running, the list and history refresh on this cadence until it settles. */
const LIVE_REFRESH_MS = 5_000;

type Action = 'pause' | 'resume' | 'run-now' | 'delete';

export function Schedules() {
  const w = useWords();
  const { locale } = useI18n();
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [form, setForm] = useState<{ schedule: Schedule | null } | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [actionError, setActionError] = useState('');
  const [runsRevision, setRunsRevision] = useState(0);

  /** `quiet` reloads in place (live refresh) without the refreshing overlay. */
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

  const selected = schedules?.find((schedule) => schedule.id === selectedId) ?? null;

  const upsert = (schedule: Schedule) => setSchedules((current) => {
    const list = current ?? [];
    return list.some((item) => item.id === schedule.id) ? list.map((item) => item.id === schedule.id ? schedule : item) : [...list, schedule];
  });

  const act = async (schedule: Schedule, action: Action) => {
    setBusy(action);
    setActionError('');
    try {
      if (action === 'delete') {
        await request<{ ok: true }>(`/api/schedules/${schedule.id}`, { method: 'DELETE' });
        setSchedules((current) => current?.filter((item) => item.id !== schedule.id) ?? null);
        setSelectedId(null);
      } else {
        const result = await request<{ schedule: Schedule }>(`/api/schedules/${schedule.id}/${action}`, { method: 'POST', body: '{}' });
        upsert(result.schedule);
        if (action === 'run-now') setRunsRevision((value) => value + 1);
      }
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
    }
  };

  const refresh = () => {
    void load();
    setRunsRevision((value) => value + 1);
  };
  const retry = <Button onClick={refresh}>{w('Retry', '重试', '重試')}</Button>;
  const loadingLabel = w('Loading schedules…', '正在加载定时任务…', '正在載入排程任務…');

  const list = <DataRegion
    state={schedules ? (schedules.length ? 'ready' : 'empty') : loading ? 'loading' : 'error'}
    loadingLabel={loadingLabel}
    refreshing={loading && schedules !== null}
    refreshingLabel={loadingLabel}
    error={loadError ? w(`Schedules could not be loaded: ${loadError}`, `无法加载定时任务：${loadError}`, `無法載入排程任務：${loadError}`) : undefined}
    retry={retry}
    empty={<EmptyState title={w('No schedules yet', '还没有定时任务', '還沒有排程任務')}
      description={w('Use New schedule to have your personal AI do a task at a set time or on a repeating rhythm, such as a morning news digest.', '点击“新建定时任务”，让个人 AI 在指定时间或按固定节奏完成工作，例如每天早上的新闻摘要。', '點選「新增排程任務」，讓個人 AI 在指定時間或依固定節奏完成工作，例如每天早上的新聞摘要。')} />}>
    <ResourceList label={w('Schedules', '定时任务', '排程任務')}>
      {schedules?.map((schedule) => {
        const state = isRunLive(schedule.last_run) && schedule.last_run ? runStatusLabel(schedule.last_run.status, w) : stateLabel(schedule.state, w);
        const next = formatDate(schedule.next_run_at, locale, schedule.timezone);
        return <ResourceRow key={schedule.id}
          leading={<Glyph name="schedule" size={16} />}
          title={schedule.name}
          selected={schedule.id === selectedId}
          onSelect={() => { setSelectedId(schedule.id); setActionError(''); }}
          selectLabel={w(`Open ${schedule.name}`, `打开 ${schedule.name}`, `開啟 ${schedule.name}`)}
          status={<StatusMark tone={state.tone} busy={isRunLive(schedule.last_run)}>{state.label}</StatusMark>}
          description={ruleLabel(schedule.schedule, schedule.timezone, locale, w)}
          meta={next ? w(`Next run ${next}`, `下次运行 ${next}`, `下次執行 ${next}`) : w('No upcoming run', '没有待运行的计划', '沒有待執行的排程')} />;
      })}
    </ResourceList>
  </DataRegion>;

  const detail = selected ? <>
    <Section title={selected.name}
      actions={<>
        <Button disabled={busy !== null} onClick={() => setForm({ schedule: selected })}>{w('Edit', '编辑', '編輯')}</Button>
        {selected.state === 'active' && <Button loading={busy === 'pause'} disabled={busy !== null} onClick={() => void act(selected, 'pause')}>{w('Pause', '暂停', '暫停')}</Button>}
        {selected.state === 'paused' && <Button loading={busy === 'resume'} disabled={busy !== null} onClick={() => void act(selected, 'resume')}>{w('Resume', '恢复', '恢復')}</Button>}
        <Popconfirm title={w(`Run “${selected.name}” now?`, `立即运行“${selected.name}”？`, `立即執行「${selected.name}」？`)}
          description={w('The instructions go to your personal AI right away; the regular timing is unchanged.', '指令会立即发送给个人 AI，原有的定时安排不变。', '指令會立即傳送給個人 AI，原有的排程不變。')}
          okText={w('Run now', '立即运行', '立即執行')} cancelText={w('Cancel', '取消', '取消')} onConfirm={() => act(selected, 'run-now')}>
          <Button loading={busy === 'run-now'} disabled={busy !== null}>{w('Run now', '立即运行', '立即執行')}</Button>
        </Popconfirm>
        <Popconfirm title={w(`Delete “${selected.name}”?`, `删除“${selected.name}”？`, `刪除「${selected.name}」？`)}
          description={w('It stops running and its history is no longer shown.', '任务将停止运行，运行记录也不再显示。', '任務將停止執行，執行記錄也不再顯示。')}
          okText={w('Delete', '删除', '刪除')} okButtonProps={{ danger: true }} cancelText={w('Cancel', '取消', '取消')} onConfirm={() => act(selected, 'delete')}>
          <Button danger loading={busy === 'delete'} disabled={busy !== null}>{w('Delete', '删除', '刪除')}</Button>
        </Popconfirm>
      </>}>
      {actionError && <Notice tone="danger" title={w('That did not work', '操作未成功', '操作未成功')}>{actionError}</Notice>}
      <FactGrid columns={2} items={[
        { key: 'rule', label: w('Timing', '时间规则', '時間規則'), value: ruleLabel(selected.schedule, selected.timezone, locale, w) },
        { key: 'zone', label: w('Time zone', '时区', '時區'), value: selected.timezone },
        { key: 'next', label: w('Next run', '下次运行', '下次執行'), value: formatDate(selected.next_run_at, locale, selected.timezone) || w('None', '无', '無') },
        { key: 'state', label: w('Status', '状态', '狀態'), value: stateLabel(selected.state, w).label },
      ]} />
      <p className="wf-schedule-prompt wf-reading">{selected.prompt}</p>
    </Section>
    <Section title={w('Run history', '运行记录', '執行記錄')}>
      <ScheduleRuns key={selected.id} scheduleId={selected.id} timezone={selected.timezone} revision={runsRevision} />
    </Section>
  </> : <EmptyState compact title={w('Select a schedule', '选择一个定时任务', '選擇一個排程任務')}
    description={w('Its instructions, timing and run history appear here.', '这里会显示它的指令、时间规则和运行记录。', '這裡會顯示它的指令、時間規則和執行記錄。')} />;

  return <PageLayout header={<PageHeader title={w('Schedules', '定时任务', '排程任務')}
    description={w('Tasks your personal AI runs on its own, at a set time or on a repeating rhythm.', '个人 AI 按指定时间或固定节奏自动执行的任务。', '個人 AI 依指定時間或固定節奏自動執行的任務。')}
    actions={<>
      <Button disabled={loading} onClick={refresh}>{w('Refresh', '刷新', '重新整理')}</Button>
      <Button type="primary" icon={<Glyph name="plus" size={16} />} onClick={() => setForm({ schedule: null })}>{w('New schedule', '新建定时任务', '新增排程任務')}</Button>
    </>} />}>
    {schedules?.length
      ? <SplitDetail list={list} detail={detail} detailOpen={selected !== null} onBack={() => setSelectedId(null)} backLabel={w('All schedules', '全部定时任务', '全部排程任務')} />
      : list}
    {form && <ScheduleForm schedule={form.schedule} onClose={() => setForm(null)} onSaved={(schedule) => {
      upsert(schedule);
      setSelectedId(schedule.id);
      setForm(null);
    }} />}
  </PageLayout>;
}
