import { Button, Table } from 'antd';
import { useWords } from '../../words';
import { DataRegion, EmptyState, FactGrid, Section } from '../../components/ui/fieldwork';
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

export function Usage() {
  const w = useWords();
  const usage = useResource<UsageReport>('/api/admin/usage');
  const data = usage.data;

  return <>
    <Section title={w('All-time totals', '累计总量', '累計總量')}
      description={w('Across personal AI, channels, and standard chat.', '涵盖个人 AI、频道和标准聊天。', '涵蓋個人 AI、頻道和標準聊天。')}
      actions={<Button onClick={() => void usage.reload()} loading={usage.refreshing}>{w('Refresh', '刷新', '重新整理')}</Button>}>
      <DataRegion state={usage.state} loadingLabel={w('Loading usage…', '正在加载用量…', '正在載入用量…')} error={usage.error}
        retry={<Button onClick={() => void usage.reload()}>{w('Retry', '重试', '重試')}</Button>} refreshing={usage.refreshing}>
        {data && <FactGrid columns={3} items={[
          { key: 'ratio', label: w('Cache-hit ratio', '缓存命中率', '快取命中率'), value: new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(data.cache_hit_ratio), hint: w('Cached input ÷ (uncached input + cached input). Higher is cheaper and faster.', '缓存输入 ÷（未缓存输入 + 缓存输入）。越高越省钱、越快。', '快取輸入 ÷（未快取輸入 + 快取輸入）。越高越省錢、越快。'), tone: data.cache_hit_ratio >= 0.5 ? 'success' : undefined },
          { key: 'input', label: w('Input tokens', '输入 Token', '輸入 Token'), value: formatNumber(data.input_tokens), hint: w('Not served from cache', '未命中缓存', '未命中快取') },
          { key: 'cache-read', label: w('Cached input tokens', '缓存输入 Token', '快取輸入 Token'), value: formatNumber(data.cache_read_tokens) },
          { key: 'cache-write', label: w('Cache write tokens', '缓存写入 Token', '快取寫入 Token'), value: formatNumber(data.cache_write_tokens) },
          { key: 'output', label: w('Output tokens', '输出 Token', '輸出 Token'), value: formatNumber(data.output_tokens) },
          { key: 'total', label: w('Total tokens', '总 Token', '總 Token'), value: formatNumber(data.total_tokens) },
        ]} />}
      </DataRegion>
    </Section>
    {data && <Section title={w('Recent runs', '最近的运行', '最近的執行')} description={w('The latest 200 agent, chat, and compaction runs, newest first.', '最近 200 次 Agent、聊天与压缩运行，按时间倒序。', '最近 200 次 Agent、聊天與壓縮執行，依時間倒序。')}>
      {data.events.length
        ? <Table<UsageEvent> aria-label={w('Recent runs', '最近的运行', '最近的執行')} rowKey="id" dataSource={data.events} size="small" scroll={{ x: 'max-content' }} pagination={{ pageSize: 20, hideOnSinglePage: true }}
            columns={[
              { key: 'time', title: w('Time', '时间', '時間'), render: (_, event) => formatTime(event.created_at) },
              { key: 'account', title: w('Account', '账户', '帳戶'), render: (_, event) => event.display_name || event.username || '—' },
              { key: 'scope', title: w('Where', '来源', '來源'), render: (_, event) => {
                const place = event.raw_usage?.kind === 'compaction' ? w('Compaction', '上下文压缩', '上下文壓縮') : event.raw_usage?.kind === 'chat' ? w('Chat', '聊天', '聊天') : event.scope_type === 'channel' ? w('Channel', '频道', '頻道') : w('Personal AI', '个人 AI', '個人 AI');
                return event.scope_name ? `${place} · ${event.scope_name}` : place;
              } },
              { key: 'model', title: w('Model', '模型', '模型'), dataIndex: 'model' },
              { key: 'input', title: w('Input', '输入', '輸入'), align: 'right', render: (_, event) => formatNumber(event.input_tokens) },
              { key: 'cache', title: w('Cached', '缓存', '快取'), align: 'right', render: (_, event) => formatNumber(event.raw_usage?.cache_read ?? event.raw_usage?.cacheRead) },
              { key: 'output', title: w('Output', '输出', '輸出'), align: 'right', render: (_, event) => formatNumber(event.output_tokens) },
              { key: 'total', title: w('Total', '合计', '合計'), align: 'right', render: (_, event) => formatNumber(event.total_tokens) },
            ]} />
        : <EmptyState compact title={w('No runs recorded yet', '暂无运行记录', '尚無執行記錄')} description={w('Usage appears here after the first agent or chat reply.', '第一次 Agent 或聊天回复后，这里会显示用量。', '第一次 Agent 或聊天回覆後，這裡會顯示用量。')} />}
    </Section>}
  </>;
}
