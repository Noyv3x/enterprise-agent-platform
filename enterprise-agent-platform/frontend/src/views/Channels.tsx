import { useId, useState } from 'react';
import { request } from '../api';
import { Button } from '../components/ui/beautiful/atoms/Button';
import { ConfirmDialog, EmptyState, Field, Icon, Notice, PageHeader, Sheet, TextArea, TextField } from '../components/ui/beautiful/controls';
import RecordsTable, { RecordsSearch, RecordsToolbar, type RecordColumn } from '../components/ui/beautiful/primitives/RecordsTable';
import { useWords } from '../words';
import { useRecordsLabels } from './admin/shared';

export interface Channel { id: number; name: string; description: string; archived: boolean }

export function Channels({ channels, onChange, onOpen, admin, permissions }: { channels: Channel[]; onChange: (channels: Channel[]) => void; onOpen: (route: string) => void; admin: boolean; permissions: string[] }) {
  const w = useWords();
  const formId = useId();
  const [editing, setEditing] = useState<Channel | 'new' | null>(null);
  const [archiving, setArchiving] = useState<Channel | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canManage = admin || permissions.includes('manage_channels');
  const labels = useRecordsLabels(w('Channels', '频道', '頻道'));
  const active = channels.filter((channel) => !channel.archived);
  const needle = query.trim().toLowerCase();
  const rows = active.filter((channel) => !needle || channel.name.toLowerCase().includes(needle) || channel.description.toLowerCase().includes(needle));
  const nameTaken = active.some((channel) => channel.name === name.trim() && (editing === 'new' || channel.id !== editing?.id));

  function edit(channel: Channel | 'new') {
    setEditing(channel);
    setName(channel === 'new' ? '' : channel.name);
    setDescription(channel === 'new' ? '' : channel.description);
    setError('');
  }
  async function save() {
    if (!editing || !name.trim() || nameTaken || busy) return;
    setBusy(true); setError('');
    try {
      const { channel } = await request<{ channel: Channel }>(editing === 'new' ? '/api/channels' : `/api/channels/${editing.id}`, { method: editing === 'new' ? 'POST' : 'PATCH', body: JSON.stringify({ name: name.trim(), description: description.trim() }) });
      onChange(editing === 'new' ? [...channels, channel] : channels.map((item) => item.id === channel.id ? channel : item));
      setEditing(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function archive() {
    if (!archiving) return;
    setBusy(true); setError('');
    try {
      await request(`/api/channels/${archiving.id}`, { method: 'DELETE' });
      onChange(channels.filter((item) => item.id !== archiving.id));
      setArchiving(null);
      setEditing(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const columns: RecordColumn<Channel>[] = [
    { key: 'description', label: w('Description', '描述', '描述'), glyph: 'text', width: 420,
      sort: (a, b) => a.description.localeCompare(b.description), muted: (channel) => !channel.description,
      render: (channel) => channel.description || '—' },
    { key: 'open', label: w('Conversation', '对话', '對話'), glyph: 'url', width: 150,
      render: (channel) => <a className="records-link" href={`#channel-${channel.id}`} onClick={(event) => { event.preventDefault(); onOpen(`channel-${channel.id}`); }}>
        <span className="records-link-label">{w('Open', '打开', '開啟')}</span><Icon name="chevronRight" size={12} />
      </a> },
  ];

  return <div className="flex min-h-0 flex-1 flex-col">
    <PageHeader
      title={w('Channels', '频道', '頻道')}
      description={canManage
        ? w('Shared conversations with your team. Open a channel to talk; open its name to rename or archive it.', '与团队共享的对话。打开频道即可交流；点击名称可重命名或归档。', '與團隊共享的對話。開啟頻道即可交流；點選名稱可重新命名或封存。')
        : w('Shared conversations with your team.', '与团队共享的对话。', '與團隊共享的對話。')}
      actions={canManage && <Button size="sm" variant="primary" onClick={() => edit('new')}><Icon name="plus" size={14} />{w('New channel', '新建频道', '新增頻道')}</Button>}
    />
    {error && !editing && !archiving && <div className="px-4 pt-3 sm:px-6"><Notice tone="danger" title={error} onDismiss={() => setError('')} /></div>}
    <div className="flex min-h-0 flex-1 flex-col">
      <RecordsTable<Channel>
        fill
        rows={rows}
        rowId={(channel) => String(channel.id)}
        primary={{ label: w('Channel', '频道', '頻道'), glyph: 'text', width: 240, name: (channel) => channel.name, mark: () => '#' }}
        columns={columns}
        labels={{ ...labels, open: (channelName: string) => canManage ? w(`Edit ${channelName}`, `编辑 ${channelName}`, `編輯 ${channelName}`) : w(`Open ${channelName}`, `打开 ${channelName}`, `開啟 ${channelName}`) }}
        selectedId={editing && editing !== 'new' ? String(editing.id) : null}
        onOpen={(channel) => canManage ? edit(channel) : onOpen(`channel-${channel.id}`)}
        empty={active.length
          ? w('No channels match the search.', '没有符合搜索的频道。', '沒有符合搜尋的頻道。')
          : <EmptyState icon="hash" title={w('No channels yet', '暂无频道', '尚無頻道')} description={canManage ? w('Create a channel to start a shared conversation.', '创建频道，开始共享对话。', '建立頻道，開始共享對話。') : w('An administrator or channel manager can create one.', '管理员或频道管理者可以创建频道。', '管理員或頻道管理者可以建立頻道。')} />}
        toolbar={<RecordsToolbar left={<RecordsSearch value={query} onChange={setQuery} label={w('Search channels', '搜索频道', '搜尋頻道')} placeholder={w('Search channels', '搜索频道', '搜尋頻道')} />} />}
      />
    </div>

    {editing && <Sheet open onClose={() => setEditing(null)}
      title={editing === 'new' ? w('New channel', '新建频道', '新增頻道') : editing.name}
      description={editing === 'new' ? w('Everyone with workspace access can read and post in it.', '拥有工作区权限的人都可以阅读和发言。', '擁有工作區權限的人都可以閱讀和發言。') : undefined}
      footer={<>
        <Button size="sm" onClick={() => setEditing(null)} disabled={busy}>{w('Cancel', '取消', '取消')}</Button>
        <Button size="sm" variant="primary" type="submit" form={formId} disabled={busy || !name.trim() || nameTaken}>
          {busy ? w('Saving…', '正在保存…', '正在儲存…') : editing === 'new' ? w('Create channel', '创建频道', '建立頻道') : w('Save', '保存', '儲存')}
        </Button>
      </>}>
      <form id={formId} noValidate className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        {error && <Notice tone="danger" title={w('The channel was not saved', '频道未保存', '頻道未儲存')}>{error}</Notice>}
        <Field label={w('Name', '名称', '名稱')} required error={nameTaken ? w('A channel with this name already exists.', '已存在同名频道。', '已存在同名頻道。') : undefined}>
          <TextField value={name} maxLength={80} autoComplete="off" onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label={w('Description', '描述', '描述')}>
          <TextArea value={description} rows={3} maxRows={8} onChange={(event) => setDescription(event.target.value)} />
        </Field>
      </form>
      {editing !== 'new' && <section className="mt-6 flex items-center justify-between gap-3 border-t border-line pt-5" aria-label={w('Archive channel', '归档频道', '封存頻道')}>
        <p className="text-[12px] leading-[1.45] text-ink-2">{w('Archiving hides the channel for everyone. Its history is kept.', '归档后所有人都看不到该频道，历史记录会保留。', '封存後所有人都看不到該頻道，歷史記錄會保留。')}</p>
        <Button size="sm" className="shrink-0 bg-red-tint text-red-ink shadow-none hover:bg-red-tint hover:brightness-95" disabled={busy} onClick={() => setArchiving(editing)}>{w('Archive', '归档', '封存')}</Button>
      </section>}
    </Sheet>}

    <ConfirmDialog
      open={archiving !== null}
      tone="danger"
      title={w(`Archive #${archiving?.name ?? ''}?`, `归档 #${archiving?.name ?? ''}？`, `封存 #${archiving?.name ?? ''}？`)}
      description={w('It disappears from the sidebar and channel list for everyone. Messages are kept.', '该频道会从所有人的侧栏和频道列表中消失，消息会保留。', '該頻道會從所有人的側欄和頻道清單中消失，訊息會保留。')}
      confirmLabel={w('Archive', '归档', '封存')}
      busy={busy}
      error={archiving ? error || undefined : undefined}
      onConfirm={() => void archive()}
      onCancel={() => { setArchiving(null); setError(''); }}
    />
  </div>;
}
