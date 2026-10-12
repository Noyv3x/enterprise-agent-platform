import { useEffect, useId, useState, type ReactNode } from 'react';
import { request, type McpAdminConnector, type McpAdminConnectors, type McpCallRow } from '../../api';
import { Button } from '../../components/ui/beautiful/atoms/Button';
import { SegmentedControl } from '../../components/ui/beautiful/atoms/SegmentedControl';
import { EmptyState, Field, FormActions, FormSection, Icon, Notice, Select, TextArea } from '../../components/ui/beautiful/controls';
import LoadingState from '../../components/ui/beautiful/primitives/LoadingState';
import RecordsTable, { RecordStatus, RecordTagList, RecordsSearch, RecordsToolbar, type RecordColumn } from '../../components/ui/beautiful/primitives/RecordsTable';
import { useWords } from '../../words';
import { ConnectorSheet } from '../mcp/ConnectorSheet';
import { STATUS_COLOR, useMcpLabels } from '../mcp/labels';
import { ALL_GROUPS } from './GroupAssignment';
import { errorText, formatNumber, formatTime, useAdminLabels, useRecordsLabels, useResource } from './shared';

type View = 'connectors' | 'calls' | 'network';
const BASE = '/api/admin/mcp/connectors';
const CALL_LIMIT = 200;

/** Admin → Connectors: organization MCP connectors (definition, credential mode, pre-registered OAuth client,
 * groups, enable, per-tool switches, shared sign-in), the recent-call audit, and the internal-network allowlist
 * that lets connectors reach private addresses. */
export function Connectors() {
  const w = useWords();
  const labels = useMcpLabels();
  const admin = useAdminLabels();
  const data = useResource<McpAdminConnectors>(BASE);
  const [view, setView] = useState<View>('connectors');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<number | 'new' | null>(null);
  const [addedId, setAddedId] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const tableLabels = useRecordsLabels(w('Organization connectors', '组织连接器', '組織連接器'));
  const views: Record<View, string> = { connectors: w('Connectors', '连接器', '連接器'), calls: w('Recent calls', '调用记录', '呼叫記錄'), network: w('Internal network', '内网访问', '內網存取') };

  const switcher = <SegmentedControl options={[views.connectors, views.calls, views.network]} value={views[view]} className="shrink-0 whitespace-nowrap touch:h-11"
    onChange={(label) => { setView((Object.keys(views) as View[]).find((key) => views[key] === label) ?? 'connectors'); setOpenId(null); }} />;

  if (data.state !== 'ready' || !data.data) {
    return <div className="p-4 sm:p-6">
      {data.state === 'loading'
        ? <LoadingState label={w('Loading connectors…', '正在加载连接器…', '正在載入連接器…')} />
        : <Notice tone="danger" title={w('Connectors could not be loaded', '无法加载连接器', '無法載入連接器')} action={<Button size="sm" className="touch:h-11" onClick={() => void data.reload()}>{w('Retry', '重试', '重試')}</Button>}>{data.error}</Notice>}
    </div>;
  }

  const { connectors, groups } = data.data;
  const oauthWarning = data.data.oauth_warning === 'https_required';
  const needle = query.trim().toLowerCase();
  const rows = connectors.filter((connector) => !needle || [connector.name, connector.label, connector.url ?? ''].some((text) => text.toLowerCase().includes(needle)));
  const opened = typeof openId === 'number' ? connectors.find((connector) => connector.id === openId) ?? null : null;
  const audience = (connector: McpAdminConnector) => connector.groups.includes(ALL_GROUPS) ? [w('Everyone', '所有人', '所有人')] : connector.groups.map(admin.group);
  const add = <Button size="sm" variant="primary" onClick={() => { setNotice(null); setOpenId('new'); }}><Icon name="plus" size={14} />{w('Add connector', '添加连接器', '新增連接器')}</Button>;

  const columns: RecordColumn<McpAdminConnector>[] = [
    { key: 'status', label: w('Status', '状态', '狀態'), glyph: 'single', width: 140,
      sort: (a, b) => labels.status(a).localeCompare(labels.status(b)),
      render: (connector) => <RecordStatus color={STATUS_COLOR[labels.tone(connector)]}>{labels.status(connector)}</RecordStatus> },
    { key: 'url', label: w('Server URL', '服务地址', '服務位址'), glyph: 'url', width: 260,
      render: (connector) => <span className="truncate font-mono text-[12px]" title={connector.url ?? ''}>{connector.url}</span> },
    { key: 'auth', label: w('Authentication', '认证方式', '驗證方式'), glyph: 'single', width: 150, render: (connector) => labels.auth(connector.auth) },
    { key: 'mode', label: w('Credentials', '凭据', '憑證'), glyph: 'user', width: 120,
      muted: (connector) => connector.auth === 'none', render: (connector) => connector.auth === 'none' ? '—' : labels.credentialMode(connector) },
    { key: 'groups', label: w('Available to', '可使用的权限组', '可使用的權限群組'), glyph: 'multi', width: 200,
      render: (connector) => <RecordTagList label={w('Available to', '可使用的权限组', '可使用的權限群組')}
        tags={audience(connector).map((label, index) => ({ key: connector.groups[index] ?? label, label, hue: connector.groups.includes(ALL_GROUPS) ? 'neutral' as const : undefined }))} /> },
    { key: 'tools', label: w('Tools', '工具', '工具'), glyph: 'json', width: 110,
      sort: (a, b) => (a.tool_count ?? -1) - (b.tool_count ?? -1),
      muted: (connector) => typeof connector.tool_count !== 'number',
      render: (connector) => <span className="tabular-nums">{typeof connector.tool_count === 'number' ? formatNumber(connector.tool_count) : '—'}</span> },
  ];

  return <div className="flex min-h-0 flex-1 flex-col">
    {oauthWarning && connectors.some((connector) => connector.auth === 'oauth') && view === 'connectors' &&
      <Notice tone="warning" title={labels.httpsWarning.title} className="mx-3 mt-3">{labels.httpsWarning.body}</Notice>}
    {notice && <Notice tone={notice.tone} title={notice.text} onDismiss={() => setNotice(null)} className="mx-3 mt-3" />}
    {view === 'connectors' && <RecordsTable<McpAdminConnector>
      fill
      rows={rows}
      rowId={(connector) => String(connector.id)}
      primary={{ label: w('Connector', '连接器', '連接器'), glyph: 'text', width: 200, name: (connector) => connector.label || connector.name }}
      columns={columns}
      labels={tableLabels}
      selectedId={opened ? String(opened.id) : null}
      onOpen={(connector) => { setNotice(null); setOpenId(connector.id); }}
      empty={connectors.length ? w('No connectors match the search.', '没有符合搜索的连接器。', '沒有符合搜尋的連接器。') : <EmptyState icon="globe" title={w('No organization connectors yet', '还没有组织连接器', '還沒有組織連接器')}
        description={w('Add a remote MCP server such as Notion, GitHub or an internal system, then choose who can use it.', '添加 Notion、GitHub 或内部系统等远程 MCP 服务，再选择谁可以使用。', '新增 Notion、GitHub 或內部系統等遠端 MCP 服務，再選擇誰可以使用。')} action={add} />}
      toolbar={<RecordsToolbar
        left={<>{switcher}<RecordsSearch value={query} onChange={setQuery} label={w('Search connectors', '搜索连接器', '搜尋連接器')} placeholder={w('Search names or addresses', '搜索名称或地址', '搜尋名稱或位址')} /></>}
        right={<>
          <button type="button" className="records-quiet-button" disabled={data.refreshing} onClick={() => void data.reload()}><Icon name="refresh" size={14} />{w('Refresh', '刷新', '重新整理')}</button>
          {add}
        </>} />}
    />}
    {view === 'calls' && <CallLog connectors={connectors} switcher={switcher} />}
    {view === 'network' && <NetworkSettings switcher={switcher} />}

    {view === 'connectors' && openId !== null && (openId === 'new' || opened) && <ConnectorSheet
      key={openId}
      connector={opened}
      base={BASE}
      admin={{ groups, redirectUri: data.data.oauth_redirect_uri }}
      manageable
      allowLocal={false}
      oauthWarning={oauthWarning}
      takenNames={connectors.filter((connector) => connector.id !== opened?.id).map((connector) => connector.name)}
      onClose={() => { setOpenId(null); setAddedId(null); }}
      onRefresh={() => data.reload(true)}
      onCreated={(connector) => { setAddedId(connector.id); setOpenId(connector.id); }}
      justAdded={opened !== null && opened.id === addedId}
      onDeleted={(text) => { setOpenId(null); setNotice({ tone: 'success', text }); void data.reload(true); }}
    />}
  </div>;
}

/** The latest audited calls: who, which connector and tool, status and duration; never arguments or results. */
function CallLog({ connectors, switcher }: { connectors: McpAdminConnector[]; switcher: ReactNode }) {
  const w = useWords();
  const labels = useMcpLabels();
  const [connector, setConnector] = useState<string>('');
  const calls = useResource<{ calls: McpCallRow[] }>(`/api/admin/mcp/calls?limit=${CALL_LIMIT}${connector ? `&connector=${connector}` : ''}`);
  const tableLabels = useRecordsLabels(w('Recent connector calls', '最近的连接器调用', '最近的連接器呼叫'));
  const rows = calls.data?.calls ?? [];
  const columns: RecordColumn<McpCallRow>[] = [
    { key: 'connector', label: w('Connector', '连接器', '連接器'), glyph: 'text', width: 160, render: (call) => call.connector_label || call.connector_name || '—' },
    { key: 'user', label: w('Account', '账户', '帳戶'), glyph: 'user', width: 150, render: (call) => call.display_name || call.username || (call.user_id === null ? '—' : `#${call.user_id}`) },
    { key: 'status', label: w('Status', '状态', '狀態'), glyph: 'single', width: 110,
      sort: (a, b) => a.status.localeCompare(b.status),
      render: (call) => <RecordStatus color={labels.callColor(call.status)}>{labels.call(call.status)}</RecordStatus> },
    { key: 'duration', label: w('Duration', '耗时', '耗時'), glyph: 'date', width: 100,
      sort: (a, b) => a.duration_ms - b.duration_ms,
      render: (call) => <span className="font-mono text-[12px] tabular-nums">{call.duration_ms < 1000 ? `${call.duration_ms} ms` : `${(call.duration_ms / 1000).toFixed(1)} s`}</span> },
    { key: 'scope', label: w('Where', '来源会话', '來源對話'), glyph: 'json', width: 150, render: (call) => <span className="font-mono text-[12px]">{call.scope_key}</span> },
    { key: 'at', label: w('Time', '时间', '時間'), glyph: 'date', width: 180,
      sort: (a, b) => a.at - b.at,
      render: (call) => <span className="font-mono text-[12px] tabular-nums">{formatTime(call.at)}</span> },
  ];
  const filter = <Select<string> size="sm" value={connector} className="w-[200px]" aria-label={w('Connector', '连接器', '連接器')}
    options={[{ value: '', label: w('All connectors', '全部连接器', '全部連接器') }, ...connectors.map((item) => ({ value: String(item.id), label: item.label || item.name }))]}
    onChange={setConnector} />;
  const toolbar = <RecordsToolbar left={<>{switcher}{filter}</>}
    right={<button type="button" className="records-quiet-button" disabled={calls.loading} onClick={() => void calls.reload()}><Icon name="refresh" size={14} />{w('Refresh', '刷新', '重新整理')}</button>} />;
  if (calls.state === 'error') {
    return <div className="flex flex-col">{toolbar}<div className="p-4"><Notice tone="danger" title={w('Calls could not be loaded', '无法加载调用记录', '無法載入呼叫記錄')} action={<Button size="sm" className="touch:h-11" onClick={() => void calls.reload()}>{w('Retry', '重试', '重試')}</Button>}>{calls.error}</Notice></div></div>;
  }
  return <RecordsTable<McpCallRow>
    fill
    rows={rows}
    rowId={(call) => String(call.id)}
    primary={{ label: w('Tool', '工具', '工具'), glyph: 'text', width: 200, name: (call) => call.tool }}
    columns={columns}
    labels={tableLabels}
    initialSort={{ key: 'at', dir: -1 }}
    empty={calls.state === 'loading' ? <LoadingState label={w('Loading calls…', '正在加载调用记录…', '正在載入呼叫記錄…')} />
      : <EmptyState icon="history" title={w('No calls yet', '还没有调用', '還沒有呼叫')} description={w('Each time an AI uses a connector tool, who, which tool, the outcome and the duration are recorded here. Arguments and results are never stored.', 'AI 每次使用连接器工具时，都会在这里记录调用者、工具、结果和耗时。不会保存参数和返回内容。', 'AI 每次使用連接器工具時，都會在這裡記錄呼叫者、工具、結果和耗時。不會儲存參數和回傳內容。')} />}
    toolbar={toolbar}
  />;
}

/** `mcp_private_networks_v1`: hosts and CIDRs connectors may reach although they resolve to private addresses. */
function NetworkSettings({ switcher }: { switcher: ReactNode }) {
  const w = useWords();
  const id = useId();
  const settings = useResource<{ private_networks: string[] }>('/api/admin/mcp/settings');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const saved = (settings.data?.private_networks ?? []).join('\n');
  useEffect(() => { setText(saved); }, [saved]);
  const entries = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const dirty = entries.join('\n') !== saved;

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setOutcome(null);
    try {
      settings.setData(await request<{ private_networks: string[] }>('/api/admin/mcp/settings', { method: 'PUT', body: JSON.stringify({ private_networks: entries }) }));
      setOutcome({ tone: 'success', text: w('Saved. New connections use the list right away.', '已保存，新的连接立即使用这个列表。', '已儲存，新的連線立即使用這個清單。') });
    } catch (cause) {
      setOutcome({ tone: 'danger', text: errorText(cause) });
    } finally {
      setSaving(false);
    }
  }

  return <div className="flex min-h-0 flex-1 flex-col">
    <RecordsToolbar left={switcher} />
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex max-w-[880px] flex-col gap-4 p-4 sm:p-6">
        {settings.state === 'loading' ? <LoadingState label={w('Loading…', '正在加载…', '正在載入…')} />
          : settings.state === 'error' ? <Notice tone="danger" title={w('The allowlist could not be loaded', '无法加载放行列表', '無法載入放行清單')} action={<Button size="sm" className="touch:h-11" onClick={() => void settings.reload()}>{w('Retry', '重试', '重試')}</Button>}>{settings.error}</Notice>
          : <FormSection title={w('Internal addresses connectors may reach', '允许连接器访问的内网地址', '允許連接器存取的內網位址')} onSubmit={() => void save()}
            description={w('Connectors may only reach public internet addresses. List the internal hosts or networks that are allowed too, for an MCP server inside your company network.', '连接器默认只能访问公网地址。如果 MCP 服务部署在公司内网，请在这里列出允许访问的内网主机或网段。', '連接器預設只能存取公網位址。如果 MCP 服務部署在公司內網，請在這裡列出允許存取的內網主機或網段。')}
            footer={<FormActions status={outcome && <Notice tone={outcome.tone} title={outcome.text} />}>
              <Button type="submit" size="sm" variant="primary" className="touch:h-11 touch:px-4" disabled={!dirty || saving} aria-busy={saving || undefined}>{saving ? w('Saving…', '正在保存…', '正在儲存…') : w('Save', '保存', '儲存')}</Button>
            </FormActions>}>
            <Field label={w('Hosts and networks', '主机和网段', '主機和網段')} id={`${id}-networks`}
              hint={w('One per line: a host name (wiki.corp.example) or a CIDR range (10.20.0.0/16). Every other private address stays blocked.', '每行一个：主机名（wiki.corp.example）或 CIDR 网段（10.20.0.0/16）。其他内网地址仍然禁止访问。', '每行一個：主機名稱（wiki.corp.example）或 CIDR 網段（10.20.0.0/16）。其他內網位址仍然禁止存取。')}>
              <TextArea value={text} rows={5} maxRows={16} spellCheck={false} disabled={saving} className="font-mono text-[12.5px]" placeholder={'wiki.corp.example\n10.20.0.0/16'}
                onChange={(event) => { setText(event.target.value); setOutcome(null); }} />
            </Field>
          </FormSection>}
      </div>
    </div>
  </div>;
}
