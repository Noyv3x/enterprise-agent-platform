import { useEffect, useState } from 'react';
import { request } from '../../api';
import { Button } from '../../components/ui/beautiful/atoms/Button';
import { EmptyState, Notice } from '../../components/ui/beautiful/controls';
import LoadingState from '../../components/ui/beautiful/primitives/LoadingState';
import TaskRows from '../../components/ui/beautiful/primitives/TaskRows';
import { useI18n } from '../../i18n';
import { useWords } from '../../words';
import { runStatusLabel } from './labels';
import { formatDate } from './model';
import type { ScheduleRun } from './model';

/** Run history of one schedule; mount with `key={scheduleId}` and bump `revision` to reload after a run started or finished. */
export function ScheduleRuns({ scheduleId, timezone, revision }: { scheduleId: number; timezone: string; revision: number }) {
  const w = useWords();
  const { locale } = useI18n();
  const [runs, setRuns] = useState<ScheduleRun[] | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let current = true;
    setError('');
    request<{ runs: ScheduleRun[] }>(`/api/schedules/${scheduleId}/runs`)
      .then((result) => { if (current) setRuns(result.runs); })
      .catch((failure: unknown) => { if (current) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => { current = false; };
  }, [scheduleId, revision, retry]);

  // Reloads after `revision` changes update the list in place; only the first load shows a loading state.
  return <>
    {error && <Notice tone="danger" title={w('Run history could not be loaded', '无法加载运行记录', '無法載入執行記錄')}
      action={<Button size="sm" onClick={() => setRetry((value) => value + 1)}>{w('Retry', '重试', '重試')}</Button>}>{error}</Notice>}
    {!runs && !error && <LoadingState label={w('Loading run history…', '正在加载运行记录…', '正在載入執行記錄…')} />}
    {runs && !runs.length && <EmptyState icon="history" title={w('No runs yet', '还没有运行记录', '還沒有執行記錄')}
      description={w('Runs appear here when the schedule fires or when you use Run now.', '定时触发或点击“立即运行”后，记录会显示在这里。', '排程觸發或點選「立即執行」後，記錄會顯示在這裡。')} />}
    {!!runs?.length && <TaskRows
      variant="List"
      ariaLabel={w('Run history', '运行记录', '執行記錄')}
      rows={runs.map((run) => {
      const status = runStatusLabel(run.status, w);
      const when = formatDate(run.started_at || run.scheduled_for, locale, timezone);
      const details = [
        { label: w('Scheduled for', '计划时间', '排定時間'), meta: formatDate(run.scheduled_for, locale, timezone) || '—' },
        { label: w('Started', '开始', '開始'), meta: formatDate(run.started_at, locale, timezone) || '—' },
        { label: w('Finished', '结束', '結束'), meta: formatDate(run.finished_at, locale, timezone) || '—' },
        ...(run.error ? [{ label: w('Error', '错误', '錯誤'), meta: run.error, wide: true }] : []),
      ];
      return {
        key: String(run.id),
        label: run.trigger === 'manual' ? w('Manual run', '手动运行', '手動執行') : w('Scheduled run', '定时运行', '排程執行'),
        amount: when,
        status: status.badge,
        pill: { tone: status.tone, label: status.label },
        details,
      };
    })}
    />}
  </>;
}
