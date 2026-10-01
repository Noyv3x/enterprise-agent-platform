import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/beautiful/atoms/Button';
import { EmptyState, Icon, Notice } from '../../components/ui/beautiful/controls';
import FilterTable, { FilterStatusPill, type FilterColumn, type FilterTone } from '../../components/ui/beautiful/primitives/FilterTable';
import InsightCards, { AllocationCard, CompareCard, InsightMono, TrendCard, type InsightPage } from '../../components/ui/beautiful/primitives/InsightCards';
import LoadingState from '../../components/ui/beautiful/primitives/LoadingState';
import { useI18n } from '../../i18n';
import { useWords } from '../../words';
import { formatNumber, formatTime, useResource } from './shared';

interface UsageEvent {
  id: number;
  created_at: string;
  user_id: number | null;
  username: string;
  display_name: string;
  scope_type: string;
  scope_name: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  /** `kind` is absent on rows recorded before chat mode; those are agent runs. Legacy rows spell cache reads `cacheRead`. */
  raw_usage: { kind?: 'agent' | 'chat' | 'compaction'; cache_read?: number; cacheRead?: number } | null;
}
interface UsageReport { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; total_tokens: number; cache_hit_ratio: number; events: UsageEvent[] }

type Place = 'personal' | 'channel' | 'chat' | 'compaction';
type PlaceFilter = 'all' | Place;

const cacheRead = (event: UsageEvent) => event.raw_usage?.cache_read ?? event.raw_usage?.cacheRead ?? 0;

function placeOf(event: UsageEvent): Place {
  if (event.raw_usage?.kind === 'compaction') return 'compaction';
  if (event.raw_usage?.kind === 'chat') return 'chat';
  return event.scope_type === 'channel' ? 'channel' : 'personal';
}

/** Events grouped by local day (or by hour when they all fall on one day), oldest first. */
function buckets(events: UsageEvent[], locale: string) {
  const sorted = [...events].filter((event) => !Number.isNaN(new Date(event.created_at).getTime()))
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const day = (event: UsageEvent) => new Date(event.created_at).toDateString();
  const hourly = sorted.length > 0 && day(sorted[0]) === day(sorted[sorted.length - 1]);
  const groups: { label: string; events: UsageEvent[] }[] = [];
  const format = new Intl.DateTimeFormat(locale, hourly ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' });
  for (const event of sorted) {
    const date = new Date(event.created_at);
    if (hourly) date.setMinutes(0, 0, 0); else date.setHours(0, 0, 0, 0);
    const label = format.format(date);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.events.push(event); else groups.push({ label, events: [event] });
  }
  // A line needs two points; a single bucket is drawn flat.
  if (groups.length === 1) groups.unshift({ label: groups[0].label, events: groups[0].events });
  return groups;
}

function useNarrow() {
  const query = '(max-width: 900px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const update = () => setNarrow(list.matches);
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, []);
  return narrow;
}

export function Usage() {
  const w = useWords();
  const { locale } = useI18n();
  const usage = useResource<UsageReport>('/api/admin/usage');
  const narrow = useNarrow();
  const data = usage.data;

  if (!data) {
    return <div className="p-4 sm:p-6">
      {usage.state === 'error'
        ? <Notice tone="danger" title={w('Usage could not be loaded', '无法加载用量', '無法載入用量')} action={<Button size="sm" onClick={() => void usage.reload()}>{w('Retry', '重试', '重試')}</Button>}>{usage.error}</Notice>
        : <LoadingState label={w('Loading usage…', '正在加载用量…', '正在載入用量…')} />}
    </div>;
  }

  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
  const tokens = (value: number) => compact.format(Math.max(0, Math.round(value)));
  const placeLabel: Record<Place, string> = {
    personal: w('Personal AI', '个人 AI', '個人 AI'),
    channel: w('Channel', '频道', '頻道'),
    chat: w('Chat', '聊天', '聊天'),
    compaction: w('Compaction', '上下文压缩', '上下文壓縮'),
  };
  const placeTone: Record<Place, FilterTone> = { personal: 'progress', channel: 'todo', chat: 'done', compaction: 'neutral' };

  const groups = buckets(data.events, locale);
  const bucketLabels = groups.map((group) => group.label);
  const windowTotal = data.events.reduce((sum, event) => sum + event.total_tokens, 0);
  const windowCached = data.events.reduce((sum, event) => sum + cacheRead(event), 0);
  const windowUncached = data.events.reduce((sum, event) => sum + event.input_tokens, 0);
  const windowRatio = windowCached + windowUncached ? windowCached / (windowCached + windowUncached) : 0;
  const period = w(`latest ${data.events.length} runs`, `最近 ${data.events.length} 次运行`, `最近 ${data.events.length} 次執行`);

  const byModel = new Map<string, number>();
  for (const event of data.events) byModel.set(event.model || '—', (byModel.get(event.model || '—') ?? 0) + event.total_tokens);
  const ranked = [...byModel.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, 3);
  const rest = ranked.slice(3).reduce((sum, [, value]) => sum + value, 0);
  const shares = rest > 0 ? [...top, [w('Other', '其他', '其他'), rest] as [string, number]] : top;
  const segmentStyles = [
    { cls: 'bg-orange', tone: 'text-orange-ink' },
    { cls: 'bg-accent', tone: 'text-accent-ink' },
    { cls: 'bg-green', tone: 'text-green-ink' },
    { cls: 'bg-line-strong', tone: 'text-ink-2' },
  ];

  const pages: InsightPage[] = data.events.length ? [
    {
      key: 'tokens',
      // The Chinese period label already reads "最近 N 次运行", so only English needs a lead-in.
      prose: <>{locale === 'en' && 'Token use over the '}<span className="font-medium text-ink">{period}</span>{w(` — ${tokens(windowTotal)} tokens in total.`, `共 ${tokens(windowTotal)} Token。`, `共 ${tokens(windowTotal)} Token。`)}</>,
      card: <TrendCard
        title={w('Tokens over time', 'Token 用量趋势', 'Token 用量趨勢')}
        badge={groups.length > 1 && bucketLabels[0] !== bucketLabels[bucketLabels.length - 1] ? `${bucketLabels[0]} – ${bucketLabels[bucketLabels.length - 1]}` : bucketLabels[0]}
        chartLabel={w('Tokens per period', '各时段 Token 数', '各時段 Token 數')}
        bucketLabels={bucketLabels}
        color="#3d9aff"
        tooltipColor="var(--accent)"
        metrics={[
          { key: 'tokens', label: w('Tokens', 'Token', 'Token'), values: groups.map((group) => group.events.reduce((sum, event) => sum + event.total_tokens, 0)), format: tokens, caption: w('Total tokens per period', '每个时段的 Token 总数', '每個時段的 Token 總數') },
          { key: 'runs', label: w('Runs', '运行', '執行'), values: groups.map((group) => group.events.length), format: (value) => String(Math.round(value)), caption: w('Runs per period', '每个时段的运行次数', '每個時段的執行次數') },
        ]}
        headline={w(`${tokens(windowTotal)} tokens`, `${tokens(windowTotal)} Token`, `${tokens(windowTotal)} Token`)}
        delta={w(`${formatNumber(data.total_tokens)} all-time`, `累计 ${formatNumber(data.total_tokens)}`, `累計 ${formatNumber(data.total_tokens)}`)}
        period={period}
      />,
    },
    {
      key: 'models',
      prose: <>{w('Most tokens went to ', '用量最多的模型是 ', '用量最多的模型是 ')}<span className="font-medium text-ink">{top[0]?.[0]}</span>{w(` — ${percent.format(windowTotal ? (top[0]?.[1] ?? 0) / windowTotal : 0)} of the ${period}.`, `，占${period}的 ${percent.format(windowTotal ? (top[0]?.[1] ?? 0) / windowTotal : 0)}。`, `，占${period}的 ${percent.format(windowTotal ? (top[0]?.[1] ?? 0) / windowTotal : 0)}。`)}</>,
      card: <AllocationCard
        title={w('Tokens by model', '各模型 Token', '各模型 Token')}
        groupLabel={w('Share of tokens by model', '各模型 Token 占比', '各模型 Token 占比')}
        segments={shares.map(([name, value], index) => ({
          name,
          label: name,
          pct: windowTotal ? Math.round((value / windowTotal) * 1000) / 10 : 0,
          amount: w(`${tokens(value)} tokens`, `${tokens(value)} Token`, `${tokens(value)} Token`),
          cls: segmentStyles[index].cls,
          tone: segmentStyles[index].tone,
          note: w(`${formatNumber(value)} tokens across the ${period}.`, `${period}共 ${formatNumber(value)} Token。`, `${period}共 ${formatNumber(value)} Token。`),
        }))}
      />,
    },
    {
      key: 'cache',
      prose: <>{w('All-time cache-hit ratio is ', '累计缓存命中率为 ', '累計快取命中率為 ')}<InsightMono tone={data.cache_hit_ratio >= 0.5 ? 'green' : 'neutral'}>{percent.format(data.cache_hit_ratio)}</InsightMono>{w('. Higher is cheaper and faster.', '，越高越省钱、越快。', '，越高越省錢、越快。')}</>,
      card: <CompareCard
        caption={w('Input tokens per period', '每个时段的输入 Token', '每個時段的輸入 Token')}
        badge={w(`${percent.format(windowRatio)} hit`, `命中 ${percent.format(windowRatio)}`, `命中 ${percent.format(windowRatio)}`)}
        chartLabel={w('Cached and uncached input tokens per period', '各时段缓存与未缓存输入 Token', '各時段快取與未快取輸入 Token')}
        bucketLabels={bucketLabels}
        series={[
          { name: w('Cached input', '缓存输入', '快取輸入'), values: groups.map((group) => group.events.reduce((sum, event) => sum + cacheRead(event), 0)), headline: tokens(data.cache_read_tokens), sub: w('all-time', '累计', '累計'), tone: 'green', dot: 'bg-green', color: '#25a878', tooltipColor: 'var(--green)', format: tokens },
          { name: w('Uncached input', '未缓存输入', '未快取輸入'), values: groups.map((group) => group.events.reduce((sum, event) => sum + event.input_tokens, 0)), headline: tokens(data.input_tokens), sub: w('all-time', '累计', '累計'), tone: 'neutral', dot: 'bg-ink-3', color: '#8b8f98', tooltipColor: 'var(--ink-3)', format: tokens },
        ]}
      />,
    },
  ] : [];

  const counts = (place: Place) => data.events.filter((event) => placeOf(event) === place).length;
  const columns: FilterColumn<UsageEvent>[] = [
    { key: 'time', label: w('Time', '时间', '時間'), width: 1.1, render: (event) => <span className="whitespace-nowrap tabular-nums">{formatTime(event.created_at)}</span> },
    { key: 'account', label: w('Account', '账户', '帳戶'), width: 0.9, primary: true, render: (event) => event.display_name || event.username || '—' },
    { key: 'where', label: w('Where', '来源', '來源'), width: 1.2, render: (event) => <span className="flex min-w-0 items-center gap-1.5">
      <FilterStatusPill tone={placeTone[placeOf(event)]}>{placeLabel[placeOf(event)]}</FilterStatusPill>
      {event.scope_name && <span className="truncate">{event.scope_name}</span>}
    </span> },
    { key: 'model', label: w('Model', '模型', '模型'), width: 0.8, render: (event) => <span className="truncate font-mono text-[12px]">{event.model || '—'}</span> },
    { key: 'input', label: w('Input', '输入', '輸入'), width: 0.6, align: 'end', render: (event) => formatNumber(event.input_tokens) },
    { key: 'cached', label: w('Cached', '缓存', '快取'), width: 0.6, align: 'end', render: (event) => formatNumber(cacheRead(event)) },
    { key: 'output', label: w('Output', '输出', '輸出'), width: 0.6, align: 'end', render: (event) => formatNumber(event.output_tokens) },
    { key: 'total', label: w('Total', '合计', '合計'), width: 0.6, align: 'end', render: (event) => <span className="font-medium text-ink">{formatNumber(event.total_tokens)}</span> },
  ];

  return <div className="flex flex-col gap-6 p-4 sm:p-6">
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
      {[
        { key: 'ratio', label: w('Cache-hit ratio', '缓存命中率', '快取命中率'), value: percent.format(data.cache_hit_ratio) },
        { key: 'total', label: w('Total tokens', '总 Token', '總 Token'), value: formatNumber(data.total_tokens) },
        { key: 'input', label: w('Input', '输入', '輸入'), value: formatNumber(data.input_tokens) },
        { key: 'cached', label: w('Cached input', '缓存输入', '快取輸入'), value: formatNumber(data.cache_read_tokens) },
        { key: 'write', label: w('Cache writes', '缓存写入', '快取寫入'), value: formatNumber(data.cache_write_tokens) },
        { key: 'output', label: w('Output', '输出', '輸出'), value: formatNumber(data.output_tokens) },
      ].map((item) => <div key={item.key} className="flex items-baseline gap-1.5">
        <span className="text-[12px] text-ink-2">{item.label}</span>
        <span className="text-[13px] font-medium text-ink tabular-nums">{item.value}</span>
      </div>)}
      <Button size="xs" variant="quiet" className="ml-auto" disabled={usage.refreshing} onClick={() => void usage.reload()}><Icon name="refresh" size={14} />{w('Refresh', '刷新', '重新整理')}</Button>
    </div>

    {pages.length
      ? <InsightCards variant={narrow ? 'Pager' : 'Grid'} pages={pages} labels={{ title: w('Insights', '洞察', '洞察'), previous: w('Previous insight', '上一条', '上一則'), next: w('Next insight', '下一条', '下一則') }} />
      : <EmptyState title={w('No runs recorded yet', '暂无运行记录', '尚無執行記錄')} description={w('Usage appears here after the first agent or chat reply.', '第一次 Agent 或聊天回复后，这里会显示用量。', '第一次 Agent 或聊天回覆後，這裡會顯示用量。')} />}

    {data.events.length > 0 && <section aria-labelledby="usage-events" className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="usage-events" className="text-[13px] font-semibold text-ink">{w('Recent runs', '最近的运行', '最近的執行')}</h2>
        <span className="text-[12px] text-ink-2">{w('Newest 200 agent, chat and compaction runs.', '最近 200 次 Agent、聊天与压缩运行。', '最近 200 次 Agent、聊天與壓縮執行。')}</span>
      </div>
      <FilterTable<UsageEvent, PlaceFilter>
        rows={[...data.events].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)}
        rowKey={(event) => event.id}
        columns={columns}
        minWidth={860}
        labels={{ filters: w('Filter runs by source', '按来源筛选', '依來源篩選'), table: w('Recent runs', '最近的运行', '最近的執行') }}
        filters={[
          { key: 'all', label: w('All', '全部', '全部'), count: data.events.length },
          ...(['personal', 'channel', 'chat', 'compaction'] as const).map((place) => ({ key: place, label: placeLabel[place], tone: placeTone[place], count: counts(place) })),
        ]}
        matches={(event, filter) => filter === 'all' || placeOf(event) === filter}
        empty={w('No runs from this source.', '没有来自此来源的运行。', '沒有來自此來源的執行。')}
      />
    </section>}
  </div>;
}
