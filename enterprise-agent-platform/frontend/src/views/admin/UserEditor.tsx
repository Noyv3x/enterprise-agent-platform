import { useId, useState } from 'react';
import { Button, Form, Input, Select } from 'antd';
import { request, type User } from '../../api';
import { useWords } from '../../words';
import { FormFooter, FormGrid, Notice, OverlayPanel, Section } from '../../components/ui/fieldwork';
import { THINKING_DEPTHS, errorText, useAdminLabels, type ModelOption, type PermissionGroup } from './shared';

interface Draft { username: string; display_name: string; position: string; role: string; permission_group: string; model_name: string; thinking_depth: string; password: string }

export function UserEditor({ user, self, groups, models, onSaved, onClose }: { user: User | null; self: boolean; groups: PermissionGroup[]; models: ModelOption[]; onSaved: (user: User) => void; onClose: () => void }) {
  const w = useWords();
  const labels = useAdminLabels();
  const formId = useId();
  const [initial] = useState<Draft>(() => ({
    username: user?.username ?? '',
    display_name: user?.display_name ?? '',
    position: user?.position ?? '',
    role: user?.role ?? 'user',
    permission_group: user?.permission_group ?? (groups.some((group) => group.name === 'member') ? 'member' : groups[0]?.name ?? ''),
    model_name: user?.model_name ?? '',
    thinking_depth: user?.thinking_depth === 'none' ? 'off' : user?.thinking_depth || 'medium',
    password: '',
  }));
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<Draft>) => setDraft((old) => ({ ...old, ...patch }));
  const changed = (Object.keys(draft) as (keyof Draft)[]).filter((key) => draft[key] !== initial[key]);
  const valid = draft.permission_group !== '' && (user !== null || (draft.username.trim() !== '' && draft.password !== ''));
  const modelOptions = models.map((model) => ({ value: model.id, label: model.name || model.id }));
  if (draft.model_name && !models.some((model) => model.id === draft.model_name)) modelOptions.push({ value: draft.model_name, label: `${draft.model_name} · ${w('unavailable', '不可用', '無法使用')}` });

  async function submit() {
    if (!valid || saving || !changed.length) return;
    setSaving(true); setError('');
    try {
      const body: Partial<Draft> = user ? Object.fromEntries(changed.map((key) => [key, draft[key]])) : { ...draft, username: draft.username.trim() };
      const response = user
        ? await request<{ user: User }>(`/api/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify(body) })
        : await request<{ user: User }>('/api/admin/users', { method: 'POST', body: JSON.stringify(body) });
      onSaved(response.user);
    } catch (cause) {
      setError(errorText(cause));
      setSaving(false);
    }
  }

  const field = (name: string) => `${formId}-${name}`;
  return <OverlayPanel open onClose={onClose} closeLabel={w('Close', '关闭', '關閉')}
    title={user ? w(`Edit ${user.username}`, `编辑 ${user.username}`, `編輯 ${user.username}`) : w('Create account', '创建账户', '建立帳戶')}
    description={user ? w('Update identity, access, and the personal AI model.', '修改身份资料、访问权限和个人 AI 模型。', '修改身分資料、存取權限和個人 AI 模型。') : w('Add a teammate and choose their initial access.', '添加同事并设置其初始访问权限。', '新增同事並設定其初始存取權限。')}
    footer={<FormFooter>
      <Button onClick={onClose} disabled={saving}>{w('Cancel', '取消', '取消')}</Button>
      <Button type="primary" htmlType="submit" form={formId} loading={saving} disabled={!valid || !changed.length}>{user ? w('Save account', '保存账户', '儲存帳戶') : w('Create account', '创建账户', '建立帳戶')}</Button>
    </FormFooter>}>
    <Form id={formId} layout="vertical" onFinish={() => void submit()} disabled={saving}>
      {error && <Notice tone="danger" title={error} />}
      {self && <Notice tone="warning" title={w('This is your own account. Saving changes signs you out, and you will need to sign in again.', '这是你自己的账户。保存更改后你会被登出，需要重新登录。', '這是你自己的帳戶。儲存變更後你會被登出，需要重新登入。')} />}
      <Section title={w('Identity', '身份资料', '身分資料')}>
        <FormGrid>
          <Form.Item label={w('Username', '用户名', '使用者名稱')} htmlFor={field('username')} required={!user}>
            <Input id={field('username')} value={draft.username} readOnly={!!user} autoComplete="off" maxLength={40} onChange={(event) => set({ username: event.target.value })} />
          </Form.Item>
          <Form.Item label={w('Display name', '显示名称', '顯示名稱')} htmlFor={field('display_name')}>
            <Input id={field('display_name')} value={draft.display_name} maxLength={80} onChange={(event) => set({ display_name: event.target.value })} />
          </Form.Item>
          <Form.Item label={w('Position', '职位', '職位')} htmlFor={field('position')}>
            <Input id={field('position')} value={draft.position} maxLength={80} onChange={(event) => set({ position: event.target.value })} />
          </Form.Item>
        </FormGrid>
      </Section>
      <Section title={w('Access', '访问权限', '存取權限')} description={w('Administrators can open this admin panel. The permission group decides which workspace features the account can use.', '管理员可以打开此管理面板。权限组决定账户可以使用哪些工作区功能。', '管理員可以開啟此管理面板。權限群組決定帳戶可以使用哪些工作區功能。')}>
        <FormGrid>
          <Form.Item label={w('Role', '角色', '角色')} htmlFor={field('role')}>
            <Select id={field('role')} value={draft.role} onChange={(value) => set({ role: value })}
              options={[{ value: 'user', label: w('Standard user', '普通用户', '一般使用者') }, { value: 'admin', label: w('Administrator', '管理员', '管理員') }]} />
          </Form.Item>
          <Form.Item label={w('Permission group', '权限组', '權限群組')} htmlFor={field('group')} required>
            <Select id={field('group')} value={draft.permission_group || undefined} onChange={(value) => set({ permission_group: value })}
              options={groups.map((group) => ({ value: group.name, label: labels.group(group.name) }))} />
          </Form.Item>
        </FormGrid>
      </Section>
      <Section title={w('Personal AI', '个人 AI', '個人 AI')} description={w('Model and reasoning effort used by this account’s personal AI.', '该账户个人 AI 使用的模型和思考深度。', '該帳戶個人 AI 使用的模型和思考深度。')}>
        <FormGrid>
          <Form.Item label={w('Model', '模型', '模型')} htmlFor={field('model')}>
            <Select id={field('model')} value={draft.model_name || undefined} allowClear placeholder={w('System default', '系统默认', '系統預設')}
              onChange={(value?: string) => set({ model_name: value ?? '' })} options={modelOptions} />
          </Form.Item>
          <Form.Item label={w('Thinking depth', '思考深度', '思考深度')} htmlFor={field('depth')}>
            <Select id={field('depth')} value={draft.thinking_depth} onChange={(value) => set({ thinking_depth: value })}
              options={THINKING_DEPTHS.map((depth) => ({ value: depth, label: labels.depth(depth) }))} />
          </Form.Item>
        </FormGrid>
      </Section>
      <Section title={w('Password', '密码', '密碼')}>
        <Form.Item label={user ? w('New password', '新密码', '新密碼') : w('Initial password', '初始密码', '初始密碼')} htmlFor={field('password')} required={!user}
          help={user ? w('Leave blank to keep the current password. Changing it signs the account out.', '留空则保留当前密码。修改后该账户会被登出。', '留空則保留目前密碼。修改後該帳戶會被登出。') : undefined}>
          <Input.Password id={field('password')} value={draft.password} autoComplete="new-password" onChange={(event) => set({ password: event.target.value })} />
        </Form.Item>
      </Section>
    </Form>
  </OverlayPanel>;
}
