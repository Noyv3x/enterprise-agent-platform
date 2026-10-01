import { useId, useState, type ReactNode } from 'react';
import { request, type User } from '../../api';
import { Button } from '../../components/ui/beautiful/atoms/Button';
import { ConfirmDialog, Field, FormGrid, Notice, Select, Sheet, TextField } from '../../components/ui/beautiful/controls';
import { useWords } from '../../words';
import { ChatPolicySection } from './ChatPolicySection';
import { THINKING_DEPTHS, errorText, useAdminLabels, type ModelOption, type PermissionGroup } from './shared';

interface Draft { username: string; display_name: string; position: string; role: string; permission_group: string; model_name: string; thinking_depth: string; password: string }

const SYSTEM_DEFAULT = '__system_default__';

/** Create or edit an account in a side sheet: identity, access, personal AI and password save together; the chat
 * model policy and deactivation are separate actions below, each with its own button. */
export function UserEditor({ user, self, groups, models, onSaved, onDeactivated, onClose }: {
  user: User | null;
  self: boolean;
  groups: PermissionGroup[];
  models: ModelOption[];
  onSaved: (user: User) => void;
  onDeactivated: () => void;
  onClose: () => void;
}) {
  const w = useWords();
  const labels = useAdminLabels();
  const formId = useId();
  const [initial, setInitial] = useState<Draft>(() => ({
    username: user?.username ?? '',
    display_name: user?.display_name ?? '',
    position: user?.position ?? '',
    role: user?.role ?? 'user',
    permission_group: user?.permission_group ?? (groups.some((group) => group.name === 'member') ? 'member' : groups[0]?.name ?? ''),
    model_name: user?.model_name ?? '',
    thinking_depth: user?.thinking_depth === 'none' ? 'off' : user?.thinking_depth || 'medium',
    password: '',
  }));
  const [current, setCurrent] = useState<User | null>(user);
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState('');
  const set = (patch: Partial<Draft>) => { setDraft((old) => ({ ...old, ...patch })); setSaved(false); };
  const changed = (Object.keys(draft) as (keyof Draft)[]).filter((key) => draft[key] !== initial[key]);
  const valid = draft.permission_group !== '' && (current !== null || (draft.username.trim() !== '' && draft.password !== ''));

  const modelOptions = [
    { value: SYSTEM_DEFAULT, label: w('System default', '系统默认', '系統預設') },
    ...models.map((model) => ({ value: model.id, label: model.name || model.id })),
  ];
  if (draft.model_name && !models.some((model) => model.id === draft.model_name)) modelOptions.push({ value: draft.model_name, label: `${draft.model_name} · ${w('unavailable', '不可用', '無法使用')}` });

  async function submit() {
    if (!valid || saving || !changed.length) return;
    setSaving(true); setError('');
    try {
      const body: Partial<Draft> = current ? Object.fromEntries(changed.map((key) => [key, draft[key]])) : { ...draft, username: draft.username.trim() };
      const response = current
        ? await request<{ user: User }>(`/api/admin/users/${current.id}`, { method: 'PATCH', body: JSON.stringify(body) })
        : await request<{ user: User }>('/api/admin/users', { method: 'POST', body: JSON.stringify(body) });
      onSaved(response.user);
      const next: Draft = { ...draft, password: '' };
      setCurrent(response.user);
      setInitial(next);
      setDraft(next);
      setSaved(true);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  }

  async function setActive(active: boolean) {
    if (!current) return;
    setStatusBusy(true); setStatusError('');
    try {
      if (active) {
        const response = await request<{ user: User }>(`/api/admin/users/${current.id}`, { method: 'PATCH', body: JSON.stringify({ active: true }) });
        setCurrent(response.user);
        onSaved(response.user);
      } else {
        await request(`/api/admin/users/${current.id}`, { method: 'DELETE' });
        setCurrent({ ...current, active: false });
        onDeactivated();
      }
      setConfirming(false);
    } catch (cause) {
      setStatusError(errorText(cause));
    } finally {
      setStatusBusy(false);
    }
  }

  const name = current ? current.display_name || current.username : '';
  return <Sheet
    open
    onClose={onClose}
    title={current ? name : w('New account', '新建账户', '新增帳戶')}
    description={current ? `@${current.username}` : w('Add a teammate and choose their initial access.', '添加同事并设置其初始访问权限。', '新增同事並設定其初始存取權限。')}
    footer={<>
      {saved && !changed.length && <span className="mr-auto text-[12px] font-medium text-green-ink">{w('Saved', '已保存', '已儲存')}</span>}
      {changed.length > 0 && current && <span className="mr-auto text-[12px] text-ink-2">{w('Unsaved changes', '有未保存的更改', '有未儲存的變更')}</span>}
      <Button size="sm" onClick={onClose} disabled={saving}>{changed.length ? w('Cancel', '取消', '取消') : w('Done', '完成', '完成')}</Button>
      <Button size="sm" variant="primary" type="submit" form={formId} disabled={saving || !valid || !changed.length}>
        {saving ? w('Saving…', '正在保存…', '正在儲存…') : current ? w('Save account', '保存账户', '儲存帳戶') : w('Create account', '创建账户', '建立帳戶')}
      </Button>
    </>}
  >
    <form id={formId} noValidate className="flex flex-col gap-5" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {error && <Notice tone="danger" title={w('The account was not saved', '账户未保存', '帳戶未儲存')}>{error}</Notice>}
      {self && <Notice tone="warning" title={w('This is your own account', '这是你自己的账户', '這是你自己的帳戶')}>{w('Saving changes signs you out, and you will need to sign in again.', '保存更改后你会被登出，需要重新登录。', '儲存變更後你會被登出，需要重新登入。')}</Notice>}
      <fieldset disabled={saving} className="contents">
        <EditorGroup title={w('Identity', '身份资料', '身分資料')} first>
          {!current && <Field label={w('Username', '用户名', '使用者名稱')} required>
            <TextField value={draft.username} autoComplete="off" maxLength={40} onChange={(event) => set({ username: event.target.value })} />
          </Field>}
          <FormGrid>
            <Field label={w('Display name', '显示名称', '顯示名稱')}>
              <TextField value={draft.display_name} maxLength={80} onChange={(event) => set({ display_name: event.target.value })} />
            </Field>
            <Field label={w('Position', '职位', '職位')}>
              <TextField value={draft.position} maxLength={80} onChange={(event) => set({ position: event.target.value })} />
            </Field>
          </FormGrid>
        </EditorGroup>
        <EditorGroup title={w('Access', '访问权限', '存取權限')} description={w('Administrators can open this admin panel. The permission group decides which workspace features the account can use.', '管理员可以打开此管理面板。权限组决定账户可以使用哪些工作区功能。', '管理員可以開啟此管理面板。權限群組決定帳戶可以使用哪些工作區功能。')}>
          <FormGrid>
            <Field label={w('Role', '角色', '角色')}>
              <Select value={draft.role} onChange={(role: string) => set({ role })}
                options={[{ value: 'user', label: w('Standard user', '普通用户', '一般使用者') }, { value: 'admin', label: w('Administrator', '管理员', '管理員') }]} />
            </Field>
            <Field label={w('Permission group', '权限组', '權限群組')} required>
              <Select value={draft.permission_group} onChange={(permission_group: string) => set({ permission_group })}
                placeholder={w('Choose a group', '选择权限组', '選擇權限群組')}
                options={groups.map((group) => ({ value: group.name, label: labels.group(group.name) }))} />
            </Field>
          </FormGrid>
        </EditorGroup>
        <EditorGroup title={w('Personal AI', '个人 AI', '個人 AI')}>
          <FormGrid>
            <Field label={w('Model', '模型', '模型')}>
              <Select value={draft.model_name || SYSTEM_DEFAULT} onChange={(value: string) => set({ model_name: value === SYSTEM_DEFAULT ? '' : value })} options={modelOptions} />
            </Field>
            <Field label={w('Thinking depth', '思考深度', '思考深度')}>
              <Select value={draft.thinking_depth} onChange={(thinking_depth: string) => set({ thinking_depth })}
                options={THINKING_DEPTHS.map((depth) => ({ value: depth, label: labels.depth(depth) }))} />
            </Field>
          </FormGrid>
        </EditorGroup>
        <EditorGroup title={w('Password', '密码', '密碼')}>
          <Field label={current ? w('New password', '新密码', '新密碼') : w('Initial password', '初始密码', '初始密碼')} required={!current}
            hint={current ? w('Leave blank to keep the current password. Changing it signs the account out.', '留空则保留当前密码。修改后该账户会被登出。', '留空則保留目前密碼。修改後該帳戶會被登出。') : undefined}>
            <TextField type="password" value={draft.password} autoComplete="new-password" onChange={(event) => set({ password: event.target.value })} />
          </Field>
        </EditorGroup>
      </fieldset>
    </form>

    {current && <div className="mt-5 flex flex-col gap-5 border-t border-line pt-5">
      <ChatPolicySection user={current} models={models} />
      {!self && <section aria-labelledby={`${formId}-status`} className="flex flex-col gap-2 border-t border-line pt-5">
        <h3 id={`${formId}-status`} className={EDITOR_HEADING}>{w('Sign-in access', '登录权限', '登入權限')}</h3>
        {statusError && <Notice tone="danger" title={statusError} />}
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12px] leading-[1.45] text-ink-2">{current.active
            ? w('Deactivating signs the account out everywhere and blocks new sign-ins. History is kept.', '停用后该账户会在所有设备上退出，并且无法再登录。历史记录会保留。', '停用後該帳戶會在所有裝置上登出，並且無法再登入。歷史記錄會保留。')
            : w('This account is deactivated and cannot sign in.', '该账户已停用，无法登录。', '該帳戶已停用，無法登入。')}</p>
          {current.active
            ? <Button size="sm" className="shrink-0 bg-red-tint text-red-ink shadow-none hover:bg-red-tint hover:brightness-95" onClick={() => setConfirming(true)} disabled={statusBusy}>{w('Deactivate', '停用', '停用')}</Button>
            : <Button size="sm" className="shrink-0" onClick={() => void setActive(true)} disabled={statusBusy}>{statusBusy ? w('Reactivating…', '正在重新启用…', '正在重新啟用…') : w('Reactivate', '重新启用', '重新啟用')}</Button>}
        </div>
      </section>}
    </div>}

    <ConfirmDialog
      open={confirming}
      tone="danger"
      title={w(`Deactivate ${name}?`, `停用 ${name}？`, `停用 ${name}？`)}
      description={w('The account is signed out everywhere and can no longer sign in.', '该账户将在所有设备上退出，并且无法再登录。', '該帳戶將在所有裝置上登出，並且無法再登入。')}
      confirmLabel={w('Deactivate', '停用', '停用')}
      busy={statusBusy}
      onConfirm={() => void setActive(false)}
      onCancel={() => setConfirming(false)}
    />
  </Sheet>;
}

export const EDITOR_HEADING = 'text-[13px] font-semibold text-ink';

/** A titled group of fields inside an editor sheet, separated from the previous group by a hairline. */
export function EditorGroup({ title, description, first = false, children }: { title: string; description?: string; first?: boolean; children: ReactNode }) {
  const id = useId();
  return <div role="group" aria-labelledby={id} className={`flex flex-col gap-3 ${first ? '' : 'border-t border-line pt-5'}`}>
    <div className="flex flex-col gap-0.5">
      <h3 id={id} className={EDITOR_HEADING}>{title}</h3>
      {description && <p className="text-[12px] leading-[1.45] text-ink-2">{description}</p>}
    </div>
    {children}
  </div>;
}
