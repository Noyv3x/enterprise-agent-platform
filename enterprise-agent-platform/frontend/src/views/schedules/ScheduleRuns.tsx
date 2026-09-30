import { Button } from 'antd';
import { useEffect, useState } from 'react';
import { request } from '../../api';
import { DataRegion, EmptyState, Notice, ResourceList, ResourceRow, StatusMark } from '../../components/ui/fieldwork';
import { useI18n } from '../../i18n';
import { useWords } from '../../words';
import { runStatusLabel } from './labels';
import { formatDate, isRunLive } from './model';
import type { ScheduleRun } from './model';

/** Run history of one schedule; mount with `key={scheduleId}` and bump `revision` to reload after a run started or finished. */
export function ScheduleRuns({ scheduleId, timezone, revision }: { scheduleId: number; timezone: string; revision: number }) {
  const w = useWords();
  const { locale } = useI18n();
  const [runs, setRuns] = useState<ScheduleRun[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError('');
    request<{ runs: ScheduleRun[] }>(`/api/schedules/${scheduleId}/runs`)
      .then((result) => { if (current) setRuns(result.runs); })
      .catch((failure: unknown) => { if (current) setError(failure instanceof Error ? failure.message : String(failure)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [scheduleId, revision, retry]);

  // Reloads after `revision` changes update the list in place; only the first load shows a loading state.
  return <DataRegion
    state={runs ? (runs.length ? 'ready' : 'empty') : loading ? 'loading' : 'error'}
    loadingLabel={w('Loading run history…', '正在加载运行记录…', '正在載入執行記錄…')}
    error={error ? w(`Run history could not be loaded: ${error}`, `无法加载运行记录：${error}`, `無法載入執行記錄：${error}`) : undefined}
    retry={<Button onClick={() => setRetry((value) => value + 1)}>{w('Retry', '重试', '重試')}</Button>}
    empty={<EmptyState compact title={w('No runs yet', '还没有运行记录', '還沒有執行記錄')}
      description={w('Runs appear here when the schedule fires or when you use Run now.', '定时触发或点击“立即运行”后，记录会显示在这里。', '排程觸發或點選「立即執行」後，記錄會顯示在這裡。')} />}>
    <ResourceList label={w('Run history', '运行记录', '執行記錄')}>
      {runs?.map((run) => {
        const status = runStatusLabel(run.status, w);
        const when = formatDate(run.started_at || run.scheduled_for, locale, timezone);
        const finished = formatDate(run.finished_at, locale, timezone);
        return <ResourceRow key={run.id}
          title={run.trigger === 'manual' ? w('Manual run', '手动运行', '手動執行') : w('Scheduled run', '定时运行', '排程執行')}
          status={<StatusMark tone={status.tone} busy={isRunLive(run)}>{status.label}</StatusMark>}
          meta={<span>{when}{finished && ` → ${finished}`}</span>}>
          {run.error ? <Notice tone="danger" title={run.error} /> : null}
        </ResourceRow>;
      })}
    </ResourceList>
  </DataRegion>;
}
