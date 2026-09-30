import { useState } from 'react';
import { Button, Popconfirm } from 'antd';
import { request, type User } from '../../api';
import { useWords } from '../../words';
import { DataRegion, EmptyState, Notice, ResourceList, ResourceRow, Section, StatusMark } from '../../components/ui/fieldwork';
import { ChatPolicyPanel } from './ChatPolicyPanel';
import { UserEditor } from './UserEditor';
import { errorText, useAdminLabels, useResource, type ModelCatalog, type PermissionGroup } from './shared';

export function Users() {
  const w = useWords();
  const labels = useAdminLabels();
  const users = useResource<{ users: User[] }>('/api/admin/users');
  const groups = useResource<{ groups: PermissionGroup[] }>('/api/admin/permission-groups');
  const catalog = useResource<ModelCatalog>('/api/admin/models');
  const me = useResource<{ user: User }>('/api/me');
  const selfId = me.data?.user.id;
  const [editing, setEditing] = useState<User | 'new' | null>(null);
  const [policyUser, setPolicyUser] = useState<User | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const models = catalog.data?.models ?? [];
  const list = users.data?.users ?? [];

  function saved(user: User) {
    users.setData({ users: list.some((item) => item.id === user.id) ? list.map((item) => item.id === user.id ? user : item) : [...list, user] });
    setEditing(null);
  }
  async function setActive(user: User, active: boolean) {
    setBusyId(user.id); setError('');
    try {
      if (active) {
        saved((await request<{ user: User }>(`/api/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ active: true }) })).user);
      } else {
        await request(`/api/admin/users/${user.id}`, { method: 'DELETE' });
        await users.reload(true);
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusyId(null);
    }
  }

  return <Section
    actions={<>
      <Button onClick={() => { void users.reload(); void groups.reload(); void catalog.reload(); }} loading={users.refreshing}>{w('Refresh', '刷新', '重新整理')}</Button>
      <Button type="primary" onClick={() => setEditing('new')} disabled={!groups.data}>{w('Create account', '创建账户', '建立帳戶')}</Button>
    </>}>
    {error && <Notice tone="danger" title={error} />}
    {catalog.error && <Notice tone="warning" title={w('Model catalog unavailable', '模型目录不可用', '模型目錄無法使用')}>{catalog.error}</Notice>}
    <DataRegion
      state={users.state === 'ready' && !list.length ? 'empty' : users.state}
      loadingLabel={w('Loading accounts…', '正在加载账户…', '正在載入帳戶…')}
      error={users.error}
      retry={<Button onClick={() => void users.reload()}>{w('Retry', '重试', '重試')}</Button>}
      refreshing={users.refreshing}
      empty={<EmptyState compact title={w('No accounts yet', '暂无账户', '尚無帳戶')} description={w('Create the first account to let a teammate sign in.', '创建第一个账户，让同事可以登录。', '建立第一個帳戶，讓同事可以登入。')} />}>
      <ResourceList label={w('Accounts', '账户', '帳戶')}>
        {list.map((user) => <ResourceRow
          key={user.id}
          title={user.display_name || user.username}
          description={`@${user.username}${user.position ? ` · ${user.position}` : ''}`}
          status={<>
            <StatusMark tone={user.active ? 'success' : 'neutral'}>{user.active ? w('Active', '正常', '正常') : w('Disabled', '已停用', '已停用')}</StatusMark>
            {user.role === 'admin' && <StatusMark tone="info" subtle>{w('Administrator', '管理员', '管理員')}</StatusMark>}
          </>}
          meta={`${labels.group(user.permission_group)} · ${user.model_name ? models.find((model) => model.id === user.model_name)?.name ?? user.model_name : w('System default model', '系统默认模型', '系統預設模型')} · ${labels.depth(user.thinking_depth)}`}
          actions={<>
            <Button onClick={() => setEditing(user)} disabled={busyId === user.id}>{w('Edit', '编辑', '編輯')}</Button>
            <Button onClick={() => setPolicyUser(user)} disabled={busyId === user.id}>{w('Chat models', '聊天模型', '聊天模型')}</Button>
            {user.id === selfId ? null : user.active
              ? <Popconfirm
                  title={w('Deactivate this account?', '停用此账户？', '停用此帳戶？')}
                  description={w('The account is signed out everywhere and can no longer sign in.', '该账户将在所有设备上退出，并且无法再登录。', '該帳戶將在所有裝置上登出，並且無法再登入。')}
                  okText={w('Deactivate', '停用', '停用')} cancelText={w('Cancel', '取消', '取消')} okButtonProps={{ danger: true }}
                  onConfirm={() => setActive(user, false)}>
                  <Button danger loading={busyId === user.id}>{w('Deactivate', '停用', '停用')}</Button>
                </Popconfirm>
              : <Button loading={busyId === user.id} onClick={() => void setActive(user, true)}>{w('Reactivate', '重新启用', '重新啟用')}</Button>}
          </>} />)}
      </ResourceList>
    </DataRegion>
    {editing && <UserEditor key={editing === 'new' ? 'new' : editing.id} user={editing === 'new' ? null : editing} self={editing !== 'new' && editing.id === selfId} groups={groups.data?.groups ?? []} models={models} onSaved={saved} onClose={() => setEditing(null)} />}
    {policyUser && <ChatPolicyPanel key={policyUser.id} user={policyUser} models={models} onClose={() => setPolicyUser(null)} />}
  </Section>;
}
