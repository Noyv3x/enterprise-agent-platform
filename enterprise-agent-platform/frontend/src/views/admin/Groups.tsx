import { useState } from 'react';
import { request, type User } from '../../api';
import { Button } from '../../components/ui/beautiful/atoms/Button';
import { ConfirmDialog, EmptyState, Field, Icon, MultiSelect, Notice, Sheet, TextField } from '../../components/ui/beautiful/controls';
import LoadingState from '../../components/ui/beautiful/primitives/LoadingState';
import RecordsTable, { RecordTagList, RecordsSearch, RecordsToolbar, type RecordColumn } from '../../components/ui/beautiful/primitives/RecordsTable';
import { useWords } from '../../words';
import { PERMISSIONS, errorText, useAdminLabels, useRecordsLabels, useResource, type PermissionGroup } from './shared';

export function Groups() {
  const w = useWords();
  const labels = useAdminLabels();
  const groups = useResource<{ groups: PermissionGroup[] }>('/api/admin/permission-groups');
  const users = useResource<{ users: User[] }>('/api/admin/users');
  const [editing, setEditing] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const recordsLabels = useRecordsLabels(w('Permission groups', '权限组', '權限群組'));
  const list = groups.data?.groups ?? [];
  const members = (name: string) => (users.data?.users ?? []).filter((user) => user.permission_group === name).length;

  const needle = query.trim().toLowerCase();
  const rows = list.filter((group) => !needle || group.name.toLowerCase().includes(needle) || labels.group(group.name).toLowerCase().includes(needle)
    || group.permissions.some((permission) => labels.permission(permission).toLowerCase().includes(needle)));

  const columns: RecordColumn<PermissionGroup>[] = [
    { key: 'permissions', label: w('Permissions', '权限', '權限'), glyph: 'multi', width: 420,
      sort: (a, b) => a.permissions.length - b.permissions.length,
      muted: (group) => !group.permissions.length,
      render: (group) => group.permissions.length
        ? <RecordTagList label={w('Permissions', '权限', '權限')} tags={group.permissions.map((permission) => ({ key: permission, label: labels.permission(permission) }))} />
        : w('No permissions', '无权限', '無權限') },
    { key: 'members', label: w('Accounts', '账户数', '帳戶數'), glyph: 'user', width: 120,
      sort: (a, b) => members(a.name) - members(b.name),
      render: (group) => <span className="tabular-nums">{users.data ? members(group.name) : '—'}</span>,
      footer: () => users.data ? w(`${users.data.users.length} accounts`, `共 ${users.data.users.length} 个账户`, `共 ${users.data.users.length} 個帳戶`) : null },
    { key: 'key', label: w('Identifier', '标识', '識別碼'), glyph: 'json', width: 160,
      sort: (a, b) => a.name.localeCompare(b.name),
      render: (group) => <span className="font-mono text-[12px] text-ink-2">{group.name}</span> },
  ];

  if (groups.state !== 'ready') {
    return <div className="p-4 sm:p-6">
      {groups.state === 'loading'
        ? <LoadingState label={w('Loading permission groups…', '正在加载权限组…', '正在載入權限群組…')} />
        : <Notice tone="danger" title={w('Permission groups could not be loaded', '无法加载权限组', '無法載入權限群組')} action={<Button size="sm" onClick={() => void groups.reload()}>{w('Retry', '重试', '重試')}</Button>}>{groups.error}</Notice>}
    </div>;
  }

  return <div className="flex min-h-0 flex-1 flex-col">
    <RecordsTable<PermissionGroup>
      fill
      rows={rows}
      rowId={(group) => group.name}
      primary={{ label: w('Group', '权限组', '權限群組'), glyph: 'text', width: 220, name: (group) => labels.group(group.name) }}
      columns={columns}
      labels={recordsLabels}
      selectedId={editing === '' ? null : editing}
      onOpen={(group) => setEditing(group.name)}
      empty={list.length
        ? w('No groups match the search.', '没有符合搜索的权限组。', '沒有符合搜尋的權限群組。')
        : <EmptyState title={w('No permission groups', '暂无权限组', '尚無權限群組')} description={w('Create a group, then assign accounts to it.', '创建权限组，然后把账户分配到该组。', '建立權限群組，然後將帳戶指派到該群組。')} />}
      toolbar={<RecordsToolbar
        left={<RecordsSearch value={query} onChange={setQuery} label={w('Search groups', '搜索权限组', '搜尋權限群組')} placeholder={w('Search groups or permissions', '搜索权限组或权限', '搜尋權限群組或權限')} />}
        right={<>
          <button type="button" className="records-quiet-button" disabled={groups.refreshing} onClick={() => { void groups.reload(); void users.reload(); }}>
            <Icon name="refresh" size={14} />{w('Refresh', '刷新', '重新整理')}
          </button>
          <Button size="sm" variant="primary" onClick={() => setEditing('')}>
            <Icon name="plus" size={14} />{w('New group', '新建权限组', '新增權限群組')}
          </Button>
        </>} />}
    />
    {editing !== null && <GroupEditor
      key={editing}
      group={list.find((group) => group.name === editing) ?? null}
      groups={list}
      members={editing ? members(editing) : 0}
      membersKnown={users.data !== null}
      onSaved={(next) => { groups.setData(next); }}
      onClose={() => setEditing(null)}
    />}
  </div>;
}

/** Create, edit or delete one group. The API stores the whole list, so every save sends the full list. */
function GroupEditor({ group, groups, members, membersKnown, onSaved, onClose }: {
  group: PermissionGroup | null;
  groups: PermissionGroup[];
  members: number;
  membersKnown: boolean;
  onSaved: (next: { groups: PermissionGroup[] }) => void;
  onClose: () => void;
}) {
  const w = useWords();
  const labels = useAdminLabels();
  const [name, setName] = useState(group?.name ?? '');
  const [permissions, setPermissions] = useState<string[]>(group?.permissions ?? []);
  const [current, setCurrent] = useState<PermissionGroup | null>(group);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const trimmed = name.trim();
  const nameTaken = !current && groups.some((item) => item.name === trimmed);
  // Permissions the server returns that this build does not name are kept and shown verbatim.
  const catalog = Array.from(new Set([...PERMISSIONS, ...permissions]));
  const dirty = current ? JSON.stringify(permissions) !== JSON.stringify(current.permissions) : trimmed !== '';
  const formId = `group-${current?.name ?? 'new'}`;

  async function put(next: PermissionGroup[]) {
    setSaving(true); setError('');
    try {
      const response = await request<{ groups: PermissionGroup[] }>('/api/admin/permission-groups', { method: 'PUT', body: JSON.stringify({ groups: next }) });
      onSaved(response);
      return response;
    } catch (cause) {
      setError(errorText(cause));
      return null;
    } finally {
      setSaving(false);
    }
  }
  async function save() {
    if (!dirty || saving || nameTaken || !trimmed) return;
    const entry = { name: current?.name ?? trimmed, permissions: catalog.filter((item) => permissions.includes(item)) };
    const response = await put(current ? groups.map((item) => item.name === current.name ? entry : item) : [...groups, entry]);
    if (response) {
      setCurrent(response.groups.find((item) => item.name === entry.name) ?? entry);
      setPermissions(entry.permissions);
      setSaved(true);
    }
  }
  async function remove() {
    if (!current) return;
    const response = await put(groups.filter((item) => item.name !== current.name));
    if (!response) return;
    setConfirming(false);
    onClose();
  }

  const title = current ? labels.group(current.name) : w('New permission group', '新建权限组', '新增權限群組');
  return <Sheet
    open
    onClose={onClose}
    title={title}
    description={current
      ? w(`Changes apply to every account in this group (${membersKnown ? members : '…'}).`, `修改会作用于组内所有账户（${membersKnown ? members : '…'} 个）。`, `修改會套用到群組內所有帳戶（${membersKnown ? members : '…'} 個）。`)
      : w('Name the group and choose what its accounts can use.', '为权限组命名，并选择组内账户可使用的功能。', '為權限群組命名，並選擇群組內帳戶可使用的功能。')}
    footer={<>
      {saved && !dirty && <span className="mr-auto text-[12px] font-medium text-green-ink">{w('Saved', '已保存', '已儲存')}</span>}
      <Button size="sm" onClick={onClose} disabled={saving}>{dirty ? w('Cancel', '取消', '取消') : w('Done', '完成', '完成')}</Button>
      <Button size="sm" variant="primary" type="submit" form={formId} disabled={saving || !dirty || nameTaken || !trimmed}>
        {saving ? w('Saving…', '正在保存…', '正在儲存…') : current ? w('Save group', '保存权限组', '儲存權限群組') : w('Create group', '创建权限组', '建立權限群組')}
      </Button>
    </>}
  >
    <form id={formId} noValidate className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {error && <Notice tone="danger" title={w('The group was not saved', '权限组未保存', '權限群組未儲存')}>{error}</Notice>}
      <Field label={w('Identifier', '标识', '識別碼')} required={!current}
        error={nameTaken ? w('A group with this name already exists.', '已存在同名权限组。', '已存在同名權限群組。') : undefined}
        hint={current ? w('Identifiers cannot be changed; accounts refer to them.', '标识不可修改，账户通过它引用权限组。', '識別碼無法修改，帳戶透過它參照權限群組。') : w('Lowercase letters work best, for example “analyst”.', '建议使用小写字母，例如 “analyst”。', '建議使用小寫字母，例如「analyst」。')}>
        <TextField value={name} readOnly={!!current} maxLength={40} autoComplete="off" onChange={(event) => { setName(event.target.value); setSaved(false); }} />
      </Field>
      <Field label={w('Permissions', '权限', '權限')} hint={w('Server checks stay authoritative even when a feature is hidden.', '即使界面隐藏了功能，服务器仍会校验权限。', '即使介面隱藏了功能，伺服器仍會檢查權限。')}>
        <MultiSelect values={permissions} disabled={saving} placeholder={w('No permissions', '无权限', '無權限')}
          onChange={(values: string[]) => { setPermissions(values); setSaved(false); }}
          options={catalog.map((permission) => ({ value: permission, label: labels.permission(permission) }))} />
      </Field>
    </form>
    {current && <section className="mt-6 flex flex-col gap-2 border-t border-line pt-5" aria-label={w('Delete group', '删除权限组', '刪除權限群組')}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[12px] leading-[1.45] text-ink-2">{members > 0
          ? w('Move its accounts to another group before deleting it.', '删除前请先把组内账户移到其他权限组。', '刪除前請先將群組內帳戶移到其他權限群組。')
          : w('Deleting removes the group for everyone.', '删除后所有人都无法再使用该权限组。', '刪除後所有人都無法再使用該權限群組。')}</p>
        <Button size="sm" className="shrink-0 bg-red-tint text-red-ink shadow-none hover:bg-red-tint hover:brightness-95" disabled={saving || members > 0 || !membersKnown} onClick={() => setConfirming(true)}>
          {w('Delete group', '删除权限组', '刪除權限群組')}
        </Button>
      </div>
    </section>}
    <ConfirmDialog
      open={confirming}
      tone="danger"
      title={w(`Delete ${title}?`, `删除 ${title}？`, `刪除 ${title}？`)}
      description={w('Accounts can no longer be assigned to it.', '账户将不能再被分配到该权限组。', '帳戶將無法再被指派到該權限群組。')}
      confirmLabel={w('Delete group', '删除权限组', '刪除權限群組')}
      busy={saving}
      error={confirming ? error || undefined : undefined}
      onConfirm={() => void remove()}
      onCancel={() => setConfirming(false)}
    />
  </Sheet>;
}
