import { useId, useState, type ReactNode } from 'react';
import { request, type AdminUser } from '../../api';
import { Button } from '../../components/ui/beautiful/atoms/Button';
import { ConfirmDialog, Field, FormGrid, Notice, Select, Sheet, TextField } from '../../components/ui/beautiful/controls';
import { useWords } from '../../words';
import { errorText, useAdminLabels, type ModelPolicy, type PermissionGroup } from './shared';

interface Draft { username: string; display_name: string; position: string; role: string; permission_group: string; model_policy: string; password: string }

/** Create or edit an account in a side sheet: identity, access, model policy group and password save together;
 * deactivation and impersonation are separate actions below, each with its own button. */
export function UserEditor({ user, self, groups, policies, onSaved, onDeactivated, onClose }: {
  user: AdminUser | null;
  self: boolean;
  groups: PermissionGroup[];
  policies: ModelPolicy[];
  onSaved: (user: AdminUser) => void;
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
    model_policy: user?.model_policy ?? (policies.some((policy) => policy.name === 'default') ? 'default' : policies[0]?.name ?? ''),
    password: '',
  }));
  const [current, setCurrent] = useState<AdminUser | null>(user);
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState('');
  const [impersonating, setImpersonating] = useState(false);
  const [impersonateError, setImpersonateError] = useState('');
  const set = (patch: Partial<Draft>) => { setDraft((old) => ({ ...old, ...patch })); setSaved(false); };
  const changed = (Object.keys(draft) as (keyof Draft)[]).filter((key) => draft[key] !== initial[key]);
  const valid = draft.permission_group !== '' && draft.model_policy !== '' && (current !== null || (draft.username.trim() !== '' && draft.password !== ''));

  const policyOptions = policies.map((policy) => ({ value: policy.name, label: policy.label }));
  // An account can only point at an existing group; a name the list lacks means the list failed to load.
  if (draft.model_policy && !policies.some((policy) => policy.name === draft.model_policy)) policyOptions.push({ value: draft.model_policy, label: draft.model_policy });

  async function submit() {
    if (!valid || saving || !changed.length) return;
    setSaving(true); setError('');
    try {
      const body: Partial<Draft> = current ? Object.fromEntries(changed.map((key) => [key, draft[key]])) : { ...draft, username: draft.username.trim() };
      const response = current
        ? await request<{ user: AdminUser }>(`/api/admin/users/${current.id}`, { method: 'PATCH', body: JSON.stringify(body) })
        : await request<{ user: AdminUser }>('/api/admin/users', { method: 'POST', body: JSON.stringify(body) });
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
        const response = await request<{ user: AdminUser }>(`/api/admin/users/${current.id}`, { method: 'PATCH', body: JSON.stringify({ active: true }) });
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

  /** The server swaps the session cookie; a full reload at the home route drops all admin-scoped client state. */
  async function impersonate() {
    if (!current) return;
    setImpersonating(true); setImpersonateError('');
    try {
      await request(`/api/admin/users/${current.id}/impersonate`, { method: 'POST', body: '{}' });
      location.assign('#');
      location.reload();
    } catch (cause) {
      setImpersonateError(errorText(cause));
      setImpersonating(false);
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
        <EditorGroup title={w('Models', '模型', '模型')} description={w('The model policy group decides the model and thinking depth for each use. The account does not see it.', '策略组决定每种用途的模型和思考深度。账户本人看不到。', '策略群組決定每種用途的模型和思考深度。帳戶本人看不到。')}>
          <Field label={w('Model policy group', '策略组', '策略群組')} required>
            <Select value={draft.model_policy} onChange={(model_policy: string) => set({ model_policy })}
              placeholder={w('Choose a group', '选择策略组', '選擇策略群組')} options={policyOptions} />
          </Field>
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
      <section aria-labelledby={`${formId}-impersonate`} className="flex flex-col gap-2">
        <h3 id={`${formId}-impersonate`} className={EDITOR_HEADING}>{w('Impersonation', '管理员代入', '管理員代入')}</h3>
        {impersonateError && <Notice tone="danger" title={impersonateError} />}
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12px] leading-[1.45] text-ink-2">{w('Replace your session with a normal session for this account, as if they had just signed in. Sign in again to return to your own account.', '用该账户的正常会话替换你当前的会话，如同对方刚刚登录。如需回到自己的账户，请重新登录。', '用該帳戶的正常工作階段取代你目前的工作階段，如同對方剛剛登入。如需回到自己的帳戶，請重新登入。')}</p>
          <Button size="sm" className="shrink-0" title={w('Sign in as this account', '以此账号登录', '以此帳號登入')} onClick={() => void impersonate()} disabled={self || !current.active || impersonating || saving}>
            {impersonating ? w('Switching…', '正在代入…', '正在代入…') : w('Impersonate', '管理员代入', '管理員代入')}
          </Button>
        </div>
      </section>
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
