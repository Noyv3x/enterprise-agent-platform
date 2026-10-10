import { useState } from 'react';
import type { AdminUser, User } from '../../api';
import { Button } from '../../components/ui/beautiful/atoms/Button';
import { EmptyState, Icon, Notice } from '../../components/ui/beautiful/controls';
import LoadingState from '../../components/ui/beautiful/primitives/LoadingState';
import RecordsTable, { RecordStatus, RecordTagList, RecordsFilterMenu, RecordsSearch, RecordsToolbar, type RecordColumn } from '../../components/ui/beautiful/primitives/RecordsTable';
import { useWords } from '../../words';
import { UserEditor } from './UserEditor';
import { useAdminLabels, useRecordsLabels, useResource, type ModelPolicies, type PermissionGroup } from './shared';

export function Users() {
  const w = useWords();
  const labels = useAdminLabels();
  const users = useResource<{ users: AdminUser[] }>('/api/admin/users');
  const groups = useResource<{ groups: PermissionGroup[] }>('/api/admin/permission-groups');
  const policies = useResource<ModelPolicies>('/api/admin/model-policies');
  const me = useResource<{ user: User }>('/api/me');
  const selfId = me.data?.user.id;
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<string | null>(null);
  const [group, setGroup] = useState<string | null>(null);
  const [policy, setPolicy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const policyList = policies.data?.policies ?? [];
  // A name the list does not hold (still loading, or failed) shows verbatim.
  const policyLabel = (name: string) => policyList.find((item) => item.name === name)?.label ?? name;
  const list = users.data?.users ?? [];
  const recordsLabels = useRecordsLabels(w('Accounts', '账户', '帳戶'));

  const needle = query.trim().toLowerCase();
  const rows = list.filter((user) =>
    (!needle || [user.username, user.display_name, user.position].some((value) => value.toLowerCase().includes(needle)))
    && (role === null || user.role === role)
    && (group === null || user.permission_group === group)
    && (policy === null || user.model_policy === policy)
    && (status === null || String(user.active) === status));

  const columns: RecordColumn<AdminUser>[] = [
    { key: 'username', label: w('Username', '用户名', '使用者名稱'), glyph: 'user', width: 150,
      sort: (a, b) => a.username.localeCompare(b.username), render: (user) => <span className="font-mono text-[12.5px] text-ink-2">@{user.username}</span> },
    { key: 'access', label: w('Role & group', '角色与权限组', '角色與權限群組'), glyph: 'multi', width: 220,
      sort: (a, b) => a.role.localeCompare(b.role) || a.permission_group.localeCompare(b.permission_group),
      render: (user) => <RecordTagList label={w('Access', '访问权限', '存取權限')} tags={[
        ...(user.role === 'admin' ? [{ key: 'role-admin', label: w('Admin role', '管理员角色', '管理員角色'), hue: 'purple' as const }] : []),
        { key: `group-${user.permission_group}`, label: labels.group(user.permission_group), hue: 'neutral' as const },
      ]} /> },
    { key: 'policy', label: w('Model policy group', '策略组', '策略群組'), glyph: 'model', width: 180,
      sort: (a, b) => policyLabel(a.model_policy).localeCompare(policyLabel(b.model_policy)),
      render: (user) => policyLabel(user.model_policy) },
    { key: 'position', label: w('Position', '职位', '職位'), glyph: 'text', width: 150,
      sort: (a, b) => a.position.localeCompare(b.position), muted: (user) => !user.position, render: (user) => user.position || '—' },
    { key: 'status', label: w('Status', '状态', '狀態'), glyph: 'single', width: 140,
      sort: (a, b) => Number(b.active) - Number(a.active),
      render: (user) => <RecordStatus color={user.active ? 'var(--green)' : 'var(--ink-3)'}>{user.active ? w('Active', '正常', '正常') : w('Deactivated', '已停用', '已停用')}</RecordStatus>,
      footer: (rows) => w(`${rows.filter((user) => user.active).length} active`, `${rows.filter((user) => user.active).length} 个正常`, `${rows.filter((user) => user.active).length} 個正常`) },
  ];

  const groupNames = Array.from(new Set([...(groups.data?.groups.map((item) => item.name) ?? []), ...list.map((user) => user.permission_group)]));
  const policyNames = Array.from(new Set([...policyList.map((item) => item.name), ...list.map((user) => user.model_policy)]));
  const editingUser = typeof editing === 'number' ? list.find((user) => user.id === editing) ?? null : null;

  function saved(user: AdminUser) {
    users.setData({ users: list.some((item) => item.id === user.id) ? list.map((item) => item.id === user.id ? user : item) : [...list, user] });
  }

  if (users.state !== 'ready') {
    return <div className="p-4 sm:p-6">
      {users.state === 'loading'
        ? <LoadingState label={w('Loading accounts…', '正在加载账户…', '正在載入帳戶…')} />
        : <Notice tone="danger" title={w('Accounts could not be loaded', '无法加载账户', '無法載入帳戶')} action={<Button size="sm" onClick={() => void users.reload()}>{w('Retry', '重试', '重試')}</Button>}>{users.error}</Notice>}
    </div>;
  }

  return <div className="flex min-h-0 flex-1 flex-col">
    {policies.error && <div className="px-4 pt-3 sm:px-6"><Notice tone="warning" title={w('Model policy groups unavailable', '无法加载策略组', '無法載入策略群組')}>{policies.error}</Notice></div>}
    <RecordsTable<AdminUser>
      fill
      rows={rows}
      rowId={(user) => String(user.id)}
      primary={{ label: w('Name', '名称', '名稱'), glyph: 'text', width: 230, name: (user) => user.display_name || user.username }}
      columns={columns}
      labels={recordsLabels}
      selectedId={typeof editing === 'number' ? String(editing) : null}
      onOpen={(user) => setEditing(user.id)}
      empty={list.length
        ? w('No accounts match the search or filters.', '没有符合搜索或筛选条件的账户。', '沒有符合搜尋或篩選條件的帳戶。')
        : <EmptyState title={w('No accounts yet', '暂无账户', '尚無帳戶')} description={w('Create the first account to let a teammate sign in.', '创建第一个账户，让同事可以登录。', '建立第一個帳戶，讓同事可以登入。')} />}
      toolbar={<RecordsToolbar
        left={<>
          <RecordsSearch value={query} onChange={setQuery} label={w('Search accounts', '搜索账户', '搜尋帳戶')} placeholder={w('Search name, username or position', '搜索名称、用户名或职位', '搜尋名稱、使用者名稱或職位')} />
          <RecordsFilterMenu label={w('Filter', '筛选', '篩選')} groups={[
            { key: 'role', label: w('Role', '角色', '角色'), anyLabel: w('Any role', '全部角色', '全部角色'), value: role, onChange: setRole,
              options: [{ value: 'admin', label: w('Administrator', '管理员', '管理員') }, { value: 'user', label: w('Standard user', '普通用户', '一般使用者') }] },
            { key: 'group', label: w('Permission group', '权限组', '權限群組'), anyLabel: w('Any group', '全部权限组', '全部權限群組'), value: group, onChange: setGroup,
              options: groupNames.map((name) => ({ value: name, label: labels.group(name) })) },
            { key: 'policy', label: w('Model policy group', '策略组', '策略群組'), anyLabel: w('Any policy group', '全部策略组', '全部策略群組'), value: policy, onChange: setPolicy,
              options: policyNames.map((name) => ({ value: name, label: policyLabel(name) })) },
            { key: 'status', label: w('Status', '状态', '狀態'), anyLabel: w('Any status', '全部状态', '全部狀態'), value: status, onChange: setStatus,
              options: [{ value: 'true', label: w('Active', '正常', '正常') }, { value: 'false', label: w('Deactivated', '已停用', '已停用') }] },
          ]} />
        </>}
        right={<>
          <button type="button" className="records-quiet-button" disabled={users.refreshing} onClick={() => { void users.reload(); void groups.reload(); void policies.reload(); }}>
            <Icon name="refresh" size={14} />{w('Refresh', '刷新', '重新整理')}
          </button>
          <Button size="sm" variant="primary" disabled={!groups.data || !policies.data} onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} />{w('New account', '新建账户', '新增帳戶')}
          </Button>
        </>} />}
    />
    {editing !== null && (editing === 'new' || editingUser) && <UserEditor
      key={editing}
      user={editingUser}
      self={editingUser !== null && editingUser.id === selfId}
      groups={groups.data?.groups ?? []}
      policies={policyList}
      onSaved={saved}
      onDeactivated={() => void users.reload(true)}
      onClose={() => setEditing(null)}
    />}
  </div>;
}
