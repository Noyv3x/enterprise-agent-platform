import { useState } from 'react';
import { Button, Form, Input, Modal } from 'antd';
import { request } from '../api';
import { useWords } from '../words';
import { EmptyState, Notice, PageHeader, PageLayout, ResourceList, ResourceRow, Section } from '../components/ui/fieldwork';

export interface Channel { id: number; name: string; description: string; archived: boolean }

export function Channels({ channels, onChange, onOpen, admin, permissions }: { channels: Channel[]; onChange: (channels: Channel[]) => void; onOpen: (route: string) => void; admin: boolean; permissions: string[] }) {
  const w = useWords();
  const [editing, setEditing] = useState<Channel | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Channel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canManage = admin || permissions.includes('manage_channels');
  async function save(values: {name:string;description:string}) {
    setBusy(true); setError('');
    try {
      const { channel } = await request<{channel:Channel}>(editing === 'new' ? '/api/channels' : `/api/channels/${(editing as Channel).id}`,{method:editing === 'new' ? 'POST':'PATCH',body:JSON.stringify(values)});
      onChange(editing === 'new' ? [...channels,channel] : channels.map(item=>item.id === channel.id ? channel:item)); setEditing(null);
    } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  }
  async function remove() {
    if (!deleting) return;
    setBusy(true); setError('');
    try { await request(`/api/channels/${deleting.id}`,{method:'DELETE'}); onChange(channels.filter(item=>item.id !== deleting.id)); setDeleting(null); }
    catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  }
  return <PageLayout header={<PageHeader title={w('Channels','频道','頻道')} description={w('Shared conversations with your team.','与团队共享对话。','與團隊共享對話。')} actions={canManage && <Button type="primary" onClick={()=>setEditing('new')}>{w('Create channel','创建频道','建立頻道')}</Button>} />}>
    {error && <Notice title={error} tone="danger" />}
    <Section><ResourceList>{channels.filter(channel=>!channel.archived).map(channel=><ResourceRow key={channel.id} title={channel.name} description={channel.description} onSelect={()=>onOpen(`channel-${channel.id}`)} actions={canManage && <><Button onClick={()=>setEditing(channel)}>{w('Edit','编辑','編輯')}</Button><Button danger onClick={()=>setDeleting(channel)}>{w('Delete','删除','刪除')}</Button></>} />)}</ResourceList>{!channels.some(channel=>!channel.archived) && <EmptyState title={w('No channels yet','暂无频道','尚無頻道')} />}</Section>
    <Modal open={editing !== null} destroyOnHidden onCancel={()=>setEditing(null)} footer={null} title={w('Channel','频道','頻道')}><Form key={editing === 'new' ? 'new':editing?.id} layout="vertical" initialValues={editing === 'new' ? {} : editing || {}} onFinish={save}><Form.Item name="name" label={w('Name','名称','名稱')} rules={[{required:true}]}><Input /></Form.Item><Form.Item name="description" label={w('Description','描述','描述')}><Input.TextArea /></Form.Item><Button type="primary" htmlType="submit" loading={busy}>{w('Save','保存','儲存')}</Button></Form></Modal>
    <Modal open={deleting !== null} onCancel={()=>setDeleting(null)} onOk={()=>void remove()} confirmLoading={busy} okText={w('Delete','删除','刪除')} cancelText={w('Cancel','取消','取消')} title={w('Delete channel?','删除频道？','刪除頻道？')}><p>{deleting?.name}</p></Modal>
  </PageLayout>;
}
