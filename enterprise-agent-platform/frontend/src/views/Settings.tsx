import { Button, Form, Input, Select } from 'antd';
import { useId, useMemo, useState } from 'react';
import { request } from '../api';
import type { User } from '../api';
import { FactGrid, FormFooter, FormGrid, Notice, PageHeader, PageLayout, Section } from '../components/ui/fieldwork';
import { SUPPORTED_LOCALES, useI18n } from '../i18n';
import type { Locale } from '../i18n';
import { useWords } from '../words';
import { browserTimezone, timezoneOptions } from './settings/timezones';
import './settings/settings.css';

const LOCALE_NAMES: Record<Locale, string> = { en: 'English', 'zh-CN': '简体中文', 'zh-TW': '繁體中文' };
const localeOptions = SUPPORTED_LOCALES.map((value) => ({ value, label: LOCALE_NAMES[value] }));

type Outcome = { tone: 'success' | 'danger'; text: string } | null;

export function Settings({ user, onSaved }: { user: User; onSaved: (u: User) => void }) {
  const w = useWords();
  const { locale, setLocale } = useI18n();
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

  const saveProfile = async () => {
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
    if (!currentPassword || !password || password !== confirmation) return;
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
  return <PageLayout header={<PageHeader title={w('Settings', '设置', '設定')}
    description={w('Your profile, language and sign-in password.', '你的个人资料、界面语言和登录密码。', '你的個人資料、介面語言與登入密碼。')}
    meta={<span>{savedName} · @{user.username}</span>} />}>
    <div className="wf-settings-sections">
      <Section title={w('Profile', '个人资料', '個人資料')}
        description={w('Your name is shown to colleagues in channels; the time zone is used for schedules and for the time the AI sees.', '名称会在频道中显示给同事；时区用于定时任务和 AI 看到的当前时间。', '名稱會在頻道中顯示給同事；時區用於排程任務與 AI 看到的目前時間。')}>
        <Form layout="vertical" onFinish={() => void saveProfile()} disabled={profileSaving}>
          <FormGrid>
            <Form.Item label={w('Display name', '显示名称', '顯示名稱')} htmlFor={`${id}-name`}>
              <Input id={`${id}-name`} value={displayName} autoComplete="name" maxLength={80} onChange={(event) => { setDisplayName(event.target.value); setProfileOutcome(null); }} />
            </Form.Item>
            <Form.Item label={w('Time zone', '时区', '時區')} htmlFor={`${id}-zone`}>
              <Select id={`${id}-zone`} value={timezone} options={zones} showSearch={{ optionFilterProp: 'label' }} onChange={(value: string) => { setTimezone(value); setProfileOutcome(null); }} />
            </Form.Item>
          </FormGrid>
          {profileOutcome && <Notice tone={profileOutcome.tone} title={profileOutcome.text} />}
          <FormFooter><Button type="primary" htmlType="submit" loading={profileSaving} disabled={!profileDirty || !displayName.trim()}>{w('Save profile', '保存资料', '儲存資料')}</Button></FormFooter>
        </Form>
      </Section>

      <Section title={w('Language', '语言', '語言')}
        description={w('Applies right away on this device.', '立即在此设备上生效。', '立即在此裝置上生效。')}>
        <Form layout="vertical">
          <Form.Item label={w('Interface language', '界面语言', '介面語言')} htmlFor={`${id}-locale`}>
            <Select<Locale> id={`${id}-locale`} className="wf-settings-locale" value={locale} options={localeOptions} onChange={setLocale} />
          </Form.Item>
        </Form>
      </Section>

      <Section title={w('Password', '密码', '密碼')}
        description={w('Choose a new password for signing in.', '为登录设置新密码。', '為登入設定新密碼。')}>
        <Form layout="vertical" onFinish={() => void savePassword()} disabled={passwordSaving}>
          <Form.Item label={w('Current password', '当前密码', '目前密碼')} htmlFor={`${id}-current-password`}>
            <Input.Password id={`${id}-current-password`} autoComplete="current-password" value={currentPassword} onChange={(event) => { setCurrentPassword(event.target.value); setPasswordOutcome(null); }} />
          </Form.Item>
          <FormGrid>
            <Form.Item label={w('New password', '新密码', '新密碼')} htmlFor={`${id}-password`}>
              <Input.Password id={`${id}-password`} autoComplete="new-password" value={password} onChange={(event) => { setPassword(event.target.value); setPasswordOutcome(null); }} />
            </Form.Item>
            <Form.Item label={w('Confirm new password', '确认新密码', '確認新密碼')} htmlFor={`${id}-confirmation`}
              validateStatus={mismatch ? 'error' : undefined}
              help={mismatch ? w('The passwords do not match', '两次输入的密码不一致', '兩次輸入的密碼不一致') : undefined}>
              <Input.Password id={`${id}-confirmation`} autoComplete="new-password" value={confirmation} onChange={(event) => { setConfirmation(event.target.value); setPasswordOutcome(null); }} />
            </Form.Item>
          </FormGrid>
          {passwordOutcome && <Notice tone={passwordOutcome.tone} title={passwordOutcome.text} />}
          <FormFooter><Button htmlType="submit" loading={passwordSaving} disabled={!currentPassword || !password || password !== confirmation}>{w('Change password', '修改密码', '變更密碼')}</Button></FormFooter>
        </Form>
      </Section>

      <Section title={w('Account', '账户', '帳戶')}
        description={w('Managed by your administrator.', '由管理员管理。', '由管理員管理。')}>
        <FactGrid columns={2} items={[
          { key: 'username', label: w('Username', '用户名', '使用者名稱'), value: <span className="wf-mono">{user.username}</span> },
          { key: 'role', label: w('Role', '角色', '角色'), value: user.role === 'admin' ? w('Administrator', '管理员', '管理員') : w('Member', '成员', '成員') },
          { key: 'position', label: w('Position', '职位', '職位'), value: user.position || none },
          { key: 'group', label: w('Permission group', '权限组', '權限群組'), value: user.permission_group || none },
          { key: 'model', label: w('Personal AI model', '个人 AI 模型', '個人 AI 模型'), value: user.model_name ? <span className="wf-mono">{user.model_name}</span> : none },
          { key: 'thinking', label: w('Thinking depth', '思考深度', '思考深度'), value: user.thinking_depth || none },
        ]} />
      </Section>
    </div>
  </PageLayout>;
}
