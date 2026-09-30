import { useEffect, useState } from 'react';
import { Button, Checkbox, Form, Input } from 'antd';
import { request } from '../../api';
import { useWords } from '../../words';
import { DataRegion, EmptyState, FormFooter, Notice, ResourceList, ResourceRow, Section, StatusMark } from '../../components/ui/fieldwork';
import { PERMISSIONS, errorText, useAdminLabels, useResource, type PermissionGroup } from './shared';

export function Groups() {
  const w = useWords();
  const labels = useAdminLabels();
  const groups = useResource<{ groups: PermissionGroup[] }>('/api/admin/permission-groups');
  const [draft, setDraft] = useState<PermissionGroup[]>([]);
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (groups.data) setDraft(groups.data.groups); }, [groups.data]);

  const dirty = groups.data !== null && JSON.stringify(draft) !== JSON.stringify(groups.data.groups);
  const trimmed = newName.trim();
  const nameTaken = draft.some((group) => group.name === trimmed);
  // Permissions the server returns that this build does not name are kept and shown verbatim.
  const catalog = [...PERMISSIONS, ...draft.flatMap((group) => group.permissions).filter((name) => !(PERMISSIONS as readonly string[]).includes(name))];
  const options = Array.from(new Set(catalog)).map((name) => ({ value: name, label: labels.permission(name) }));

  function edit(next: PermissionGroup[]) {
    setDraft(next);
    setSaved(false);
  }
  async function save() {
    if (!dirty || saving) return;
    setSaving(true); setError('');
    try {
      groups.setData(await request<{ groups: PermissionGroup[] }>('/api/admin/permission-groups', { method: 'PUT', body: JSON.stringify({ groups: draft }) }));
      setSaved(true);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  }

  return <Section
    description={w('Each account belongs to one group; the group decides which workspace features it can use. Changes apply to every account in the group.', '每个账户属于一个权限组，权限组决定其可使用的工作区功能。修改会作用于组内所有账户。', '每個帳戶屬於一個權限群組，權限群組決定其可使用的工作區功能。修改會套用到群組內所有帳戶。')}
    actions={<Button onClick={() => void groups.reload()} loading={groups.refreshing} disabled={saving}>{w('Refresh', '刷新', '重新整理')}</Button>}>
    {error && <Notice tone="danger" title={error} />}
    <DataRegion state={groups.state === 'ready' && !draft.length ? 'empty' : groups.state} loadingLabel={w('Loading permission groups…', '正在加载权限组…', '正在載入權限群組…')}
      error={groups.error} retry={<Button onClick={() => void groups.reload()}>{w('Retry', '重试', '重試')}</Button>} refreshing={groups.refreshing}
      empty={<EmptyState compact title={w('No permission groups', '暂无权限组', '尚無權限群組')} description={w('Add a group below, then assign accounts to it.', '在下方添加权限组，然后把账户分配到该组。', '在下方新增權限群組，然後將帳戶指派到該群組。')} />}>
      <ResourceList label={w('Permission groups', '权限组', '權限群組')}>
        {draft.map((group) => <ResourceRow key={group.name}
          title={labels.group(group.name)}
          description={labels.group(group.name) !== group.name ? group.name : undefined}
          actions={<Button danger disabled={saving} onClick={() => edit(draft.filter((item) => item.name !== group.name))}>{w('Remove', '移除', '移除')}</Button>}>
          <Checkbox.Group aria-label={w(`Permissions of ${group.name}`, `${group.name} 的权限`, `${group.name} 的權限`)} value={group.permissions} options={options} disabled={saving}
            onChange={(values) => edit(draft.map((item) => item.name === group.name ? { ...item, permissions: values as string[] } : item))} />
        </ResourceRow>)}
      </ResourceList>
    </DataRegion>
    {groups.data && <Form layout="inline" onFinish={() => { if (trimmed && !nameTaken) { edit([...draft, { name: trimmed, permissions: [] }]); setNewName(''); } }}>
      <Form.Item label={w('New group', '新权限组', '新權限群組')} validateStatus={nameTaken ? 'error' : undefined} help={nameTaken ? w('A group with this name already exists.', '已存在同名权限组。', '已存在同名權限群組。') : undefined}>
        <Input value={newName} maxLength={40} disabled={saving} onChange={(event) => setNewName(event.target.value)} />
      </Form.Item>
      <Button htmlType="submit" disabled={!trimmed || nameTaken || saving}>{w('Add group', '添加权限组', '新增權限群組')}</Button>
    </Form>}
    <FormFooter note={dirty ? <StatusMark tone="warning">{w('Unsaved changes', '有未保存的更改', '有未儲存的變更')}</StatusMark> : saved ? <StatusMark tone="success">{w('Saved', '已保存', '已儲存')}</StatusMark> : undefined}>
      <Button disabled={!dirty || saving} onClick={() => groups.data && edit(groups.data.groups)}>{w('Discard changes', '放弃更改', '放棄變更')}</Button>
      <Button type="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>{w('Save groups', '保存权限组', '儲存權限群組')}</Button>
    </FormFooter>
  </Section>;
}
