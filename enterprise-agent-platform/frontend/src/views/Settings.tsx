import { useId, useMemo, useState } from 'react';
import { request } from '../api';
import type { User } from '../api';
import { Button } from '../components/ui/beautiful/atoms/Button';
import { SegmentedControl } from '../components/ui/beautiful/atoms/SegmentedControl';
import { DescriptionList, Field, FormActions, FormGrid, FormSection, Notice, PageHeader, Select, TextField } from '../components/ui/beautiful/controls';
import type { ThemePreference } from '../context/ThemeContext';
import { useTheme } from '../hooks/useTheme';
import { useI18n, type Locale } from '../i18n';
import { LOCALE_OPTIONS } from '../shell/preferences';
import { useWords } from '../words';
import { browserTimezone, timezoneOptions } from './settings/timezones';

type Outcome = { tone: 'success' | 'danger'; text: string } | null;

const THEMES: readonly ThemePreference[] = ['light', 'dark', 'system'];
const buttonTouch = 'touch:h-11 touch:px-4';

export function Settings({ user, onSaved }: { user: User; onSaved: (u: User) => void }) {
  const w = useWords();
  const { locale, setLocale } = useI18n();
  const { preference, setPreference } = useTheme();
  const id = useId();
  const savedName = user.display_name || user.username;
  const savedZone = user.timezone || browserTimezone();
  const [displayName, setDisplayName] = useState(savedName);
  const [timezone, setTimezone] = useState(savedZone);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileOutcome, setProfileOutcome] = useState<Outcome>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordOutcome, setPasswordOutcome] = useState<Outcome>(null);
  const zones = useMemo(() => timezoneOptions(timezone), [timezone]);

  const profileDirty = displayName.trim() !== savedName || timezone !== savedZone;
  const mismatch = confirmation !== '' && password !== confirmation;
  const themeLabels: Record<ThemePreference, string> = { light: w('Light', '浅色', '淺色'), dark: w('Dark', '深色', '深色'), system: w('System', '跟随系统', '跟隨系統') };

  const saveProfile = async () => {
    if (!profileDirty || !displayName.trim() || profileSaving) return;
    setProfileSaving(true);
    setProfileOutcome(null);
    try {
      const result = await request<{ user: User }>('/api/me', { method: 'PATCH', body: JSON.stringify({ display_name: displayName.trim(), timezone }) });
      onSaved(result.user);
      setDisplayName(result.user.display_name || result.user.username);
      setTimezone(result.user.timezone || timezone);
      setProfileOutcome({ tone: 'success', text: w('Profile saved', '资料已保存', '資料已儲存') });
    } catch (failure) {
      setProfileOutcome({ tone: 'danger', text: failure instanceof Error ? failure.message : String(failure) });
    } finally {
      setProfileSaving(false);
    }
  };

  const savePassword = async () => {
    if (!currentPassword || !password || password !== confirmation || passwordSaving) return;
    setPasswordSaving(true);
    setPasswordOutcome(null);
    try {
      const result = await request<{ user: User }>('/api/me', { method: 'PATCH', body: JSON.stringify({ password, current_password: currentPassword }) });
      onSaved(result.user);
      setCurrentPassword('');
      setPassword('');
      setConfirmation('');
      setPasswordOutcome({ tone: 'success', text: w('Password changed', '密码已修改', '密碼已變更') });
    } catch (failure) {
      setPasswordOutcome({ tone: 'danger', text: failure instanceof Error ? failure.message : String(failure) });
    } finally {
      setPasswordSaving(false);
    }
  };

  const none = w('Not set', '未设置', '未設定');
  return <>
    <PageHeader title={w('Settings', '设置', '設定')} description={w('Your profile, appearance and sign-in password.', '你的个人资料、外观和登录密码。', '你的個人資料、外觀與登入密碼。')} />
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex max-w-[880px] flex-col gap-4 p-4 sm:p-6">
        <FormSection title={w('Profile', '个人资料', '個人資料')} onSubmit={() => void saveProfile()}
          description={w('Your name is shown to colleagues in channels; the time zone is used for schedules and for the time the AI sees.', '名称会在频道中显示给同事；时区用于定时任务和 AI 看到的当前时间。', '名稱會在頻道中顯示給同事；時區用於排程任務與 AI 看到的目前時間。')}
          footer={<FormActions><Button type="submit" variant="primary" size="sm" className={buttonTouch} disabled={profileSaving || !profileDirty || !displayName.trim()} aria-busy={profileSaving || undefined}>{w('Save profile', '保存资料', '儲存資料')}</Button></FormActions>}>
          <FormGrid>
            <Field label={w('Display name', '显示名称', '顯示名稱')} id={`${id}-name`}>
              <TextField value={displayName} autoComplete="name" maxLength={80} disabled={profileSaving} onChange={(event) => { setDisplayName(event.target.value); setProfileOutcome(null); }} />
            </Field>
            <Field label={w('Time zone', '时区', '時區')} id={`${id}-zone`}>
              <Select value={timezone} options={zones} searchable disabled={profileSaving} searchPlaceholder={w('Search time zones', '搜索时区', '搜尋時區')} onChange={(value) => { setTimezone(value); setProfileOutcome(null); }} />
            </Field>
          </FormGrid>
          {profileOutcome && <Notice tone={profileOutcome.tone} title={profileOutcome.text} />}
        </FormSection>

        <FormSection title={w('Appearance', '外观', '外觀')} description={w('Applies right away on this device.', '立即在此设备上生效。', '立即在此裝置上生效。')}>
          <FormGrid>
            <Field group label={w('Theme', '主题', '主題')}>
              <SegmentedControl
                options={THEMES.map((theme) => themeLabels[theme])}
                value={themeLabels[preference]}
                onChange={(label) => setPreference(THEMES.find((theme) => themeLabels[theme] === label) ?? 'system')}
                className="w-full touch:h-12"
              />
            </Field>
            <Field label={w('Interface language', '界面语言', '介面語言')} id={`${id}-locale`}>
              <Select<Locale> value={locale} options={LOCALE_OPTIONS} onChange={setLocale} />
            </Field>
          </FormGrid>
        </FormSection>

        <FormSection title={w('Password', '密码', '密碼')} onSubmit={() => void savePassword()}
          description={w('Choose a new password for signing in.', '为登录设置新密码。', '為登入設定新密碼。')}
          footer={<FormActions><Button type="submit" variant="secondary" size="sm" className={buttonTouch} disabled={passwordSaving || !currentPassword || !password || password !== confirmation} aria-busy={passwordSaving || undefined}>{w('Change password', '修改密码', '變更密碼')}</Button></FormActions>}>
          <Field label={w('Current password', '当前密码', '目前密碼')} id={`${id}-current-password`}>
            <TextField type="password" autoComplete="current-password" value={currentPassword} disabled={passwordSaving} onChange={(event) => { setCurrentPassword(event.target.value); setPasswordOutcome(null); }} />
          </Field>
          <FormGrid>
            <Field label={w('New password', '新密码', '新密碼')} id={`${id}-password`}>
              <TextField type="password" autoComplete="new-password" value={password} disabled={passwordSaving} onChange={(event) => { setPassword(event.target.value); setPasswordOutcome(null); }} />
            </Field>
            <Field label={w('Confirm new password', '确认新密码', '確認新密碼')} id={`${id}-confirmation`} error={mismatch ? w('The passwords do not match', '两次输入的密码不一致', '兩次輸入的密碼不一致') : undefined}>
              <TextField type="password" autoComplete="new-password" value={confirmation} disabled={passwordSaving} onChange={(event) => { setConfirmation(event.target.value); setPasswordOutcome(null); }} />
            </Field>
          </FormGrid>
          {passwordOutcome && <Notice tone={passwordOutcome.tone} title={passwordOutcome.text} />}
        </FormSection>

        <FormSection title={w('Account', '账户', '帳戶')} description={w('Managed by your administrator.', '由管理员管理。', '由管理員管理。')}>
          <DescriptionList items={[
            { key: 'username', label: w('Username', '用户名', '使用者名稱'), value: <span className="font-mono text-[12.5px]">{user.username}</span> },
            { key: 'role', label: w('Role', '角色', '角色'), value: user.role === 'admin' ? w('Administrator', '管理员', '管理員') : w('Standard user', '普通用户', '一般使用者') },
            { key: 'position', label: w('Position', '职位', '職位'), value: user.position || none },
            { key: 'group', label: w('Permission group', '权限组', '權限群組'), value: user.permission_group || none },
            { key: 'thinking', label: w('Thinking depth', '思考深度', '思考深度'), value: user.thinking_depth || none },
          ]} />
        </FormSection>
      </div>
    </div>
  </>;
}
