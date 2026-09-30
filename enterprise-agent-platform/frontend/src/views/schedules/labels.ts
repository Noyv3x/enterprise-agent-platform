import type { Tone } from '../../components/ui/fieldwork';
import { formatDate, splitInterval } from './model';
import type { ScheduleSpec } from './model';

/** The translator returned by useWords(). */
type Words = (en: string, zhCN?: string, zhTW?: string) => string;

export function ruleLabel(spec: ScheduleSpec, timezone: string, locale: string, w: Words): string {
  if (spec.type === 'once') {
    const time = formatDate(spec.at, locale, timezone);
    return w(`Once, ${time}`, `一次：${time}`, `一次：${time}`);
  }
  if (spec.type === 'cron') return w(`Cron ${spec.expression}`, `Cron ${spec.expression}`, `Cron ${spec.expression}`);
  const { amount, unit } = splitInterval(spec.every_seconds);
  const english = { minutes: 'minute', hours: 'hour', days: 'day' }[unit] + (amount === 1 ? '' : 's');
  const zhCN = { minutes: '分钟', hours: '小时', days: '天' }[unit];
  const zhTW = { minutes: '分鐘', hours: '小時', days: '天' }[unit];
  return w(`Every ${amount} ${english}`, `每 ${amount} ${zhCN}`, `每 ${amount} ${zhTW}`);
}

export function stateLabel(state: string, w: Words): { label: string; tone: Tone } {
  if (state === 'active') return { label: w('Active', '已启用', '已啟用'), tone: 'success' };
  if (state === 'paused') return { label: w('Paused', '已暂停', '已暫停'), tone: 'warning' };
  if (state === 'completed') return { label: w('Finished', '已结束', '已結束'), tone: 'neutral' };
  return { label: state, tone: 'neutral' };
}

export function runStatusLabel(status: string, w: Words): { label: string; tone: Tone } {
  switch (status) {
    case 'queued': return { label: w('Queued', '排队中', '排隊中'), tone: 'info' };
    case 'running': return { label: w('Running', '运行中', '執行中'), tone: 'info' };
    case 'succeeded': return { label: w('Succeeded', '已完成', '已完成'), tone: 'success' };
    case 'failed': return { label: w('Failed', '失败', '失敗'), tone: 'danger' };
    case 'interrupted': return { label: w('Interrupted', '已中断', '已中斷'), tone: 'danger' };
    case 'blocked': return { label: w('Blocked', '已阻止', '已阻擋'), tone: 'danger' };
    case 'cancelled': return { label: w('Cancelled', '已取消', '已取消'), tone: 'warning' };
    case 'skipped': return { label: w('Skipped', '已跳过', '已略過'), tone: 'warning' };
    default: return { label: status.replace(/_/g, ' '), tone: 'neutral' };
  }
}
