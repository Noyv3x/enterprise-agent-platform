import { useEffect, useState } from 'react';
import { Button, Form, Input, Select } from 'antd';
import { ApiError, request, type User } from './api';
import { I18nProvider, useI18n, type Locale } from './i18n';
import { BrandingProvider, useBranding } from './context/BrandingContext';
import { ThemeProvider } from './context/ThemeContext';
import { useTheme } from './hooks/useTheme';
import { AntDesignProvider } from './components/ui/AntDesignProvider';
import { AppFrame, AuthPage, Glyph, LoadingState, Notice, WorkspaceNav } from './components/ui/fieldwork';
import { useWords } from './words';
import { Conversation } from './views/Conversation';
import { Chat } from './views/Chat';
import { Admin } from './views/Admin';
import { Schedules } from './views/Schedules';
import { Settings } from './views/Settings';
import { Channels, type Channel } from './views/Channels';

interface Bootstrap { user: User; permissions: string[]; channels: Channel[] }

function Utilities() {
  const { locale, setLocale } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const w = useWords();
  return <><Select aria-label={w('Language', '语言', '語言')} value={locale} onChange={(value: Locale) => setLocale(value)} options={[{value:'en',label:'English'},{value:'zh-CN',label:'简体中文'},{value:'zh-TW',label:'繁體中文'}]} /><Button type="text" aria-label={w('Toggle theme', '切换主题', '切換主題')} icon={<Glyph name={theme === 'dark' ? 'sun' : 'moon'} />} onClick={toggleTheme} /></>;
}

export function Login({ onLogin }: { onLogin: () => Promise<void> }) {
  const { branding } = useBranding();
  const w = useWords();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function login(values: { username: string; password: string }) {
    setBusy(true); setError('');
    try { await request('/api/auth/login', {method:'POST',body:JSON.stringify(values)}); await onLogin(); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  return <AuthPage brand={{productName:branding.product_name,logoUrl:branding.logo_url}} title={w('Welcome back', '欢迎回来', '歡迎回來')} description={w('Sign in to your workspace.', '登录您的工作空间。', '登入您的工作空間。')} utilities={<Utilities />} form={<Form layout="vertical" onFinish={login} requiredMark={false}>
    {error && <Notice tone="danger" title={error} />}
    <Form.Item name="username" label={w('Username','用户名','使用者名稱')} rules={[{required:true,message:w('Enter your username','请输入用户名','請輸入使用者名稱')}]}><Input autoComplete="username" autoFocus /></Form.Item>
    <Form.Item name="password" label={w('Password','密码','密碼')} rules={[{required:true,message:w('Enter your password','请输入密码','請輸入密碼')}]}><Input.Password autoComplete="current-password" /></Form.Item>
    <Button htmlType="submit" type="primary" loading={busy} block>{w('Sign in','登录','登入')}</Button>
  </Form>} />;
}

function Shell() {
  const w = useWords();
  const { branding } = useBranding();
  const [session, setSession] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [route, setRoute] = useState(() => location.hash.slice(1) || 'private');
  const [navigationOpen, setNavigationOpen] = useState(false);
  async function bootstrap() {
    try { setSession(await request<Bootstrap>('/api/bootstrap')); setError(''); }
    catch (cause) { if (cause instanceof ApiError && cause.status === 401) setSession(null); else throw cause; }
  }
  useEffect(() => { void bootstrap().catch(cause => setError(cause.message)).finally(() => setLoading(false)); }, []);
  useEffect(() => { const changed = () => setRoute(location.hash.slice(1) || 'private'); window.addEventListener('hashchange',changed); return () => window.removeEventListener('hashchange',changed); }, []);
  useEffect(() => {
    const expired = () => setSession(null);
    window.addEventListener('session-expired', expired);
    return () => window.removeEventListener('session-expired', expired);
  }, []);
  function navigate(key: string) { location.hash = key; setRoute(key); }
  async function logout() {
    try { await request('/api/auth/logout',{method:'POST',body:'{}'}); setSession(null); navigate('private'); }
    catch (cause) { setError((cause as Error).message); }
  }
  if (loading) return <LoadingState label={w('Loading workspace','正在加载工作空间','正在載入工作空間')} />;
  if (!session) return error ? <Notice tone="danger" title={error} action={<Button onClick={() => { setError(''); void bootstrap().catch(cause => setError(cause.message)); }}>{w('Retry','重试','重試')}</Button>} /> : <Login onLogin={bootstrap} />;
  const admin = session.user.role === 'admin';
  const privateAccess = admin || session.permissions.includes('private_agent');
  const channelAccess = admin || session.permissions.includes('read_workspace');
  const chatAccess = admin || session.permissions.includes('chat');
  const allowed = route === 'private' || route === 'schedules' ? privateAccess : route === 'chat' ? chatAccess : route === 'channels' || route.startsWith('channel-') ? channelAccess : route === 'admin' ? admin : true;
  const items = [
    ...(privateAccess ? [{key:'private',label:w('Personal AI','个人 AI','個人 AI'),icon:<Glyph name="home" />}] : []),
    ...(channelAccess ? [{key:'channels',label:w('Channels','频道','頻道'),icon:<Glyph name="channel" />}] : []),
    ...(chatAccess ? [{key:'chat',label:w('Chat','聊天','聊天'),icon:<Glyph name="sparkle" />}] : []),
    ...(privateAccess ? [{key:'schedules',label:w('Schedules','计划任务','排程'),icon:<Glyph name="schedule" />}] : []),
    ...(admin ? [{key:'admin',label:w('Admin','管理','管理'),icon:<Glyph name="admin" />}] : []),
    {key:'settings',label:w('Settings','设置','設定'),icon:<Glyph name="settings" />},
  ];
  const scope = route === 'private' || /^channel-\d+$/.test(route) ? route : null;
  return <AppFrame brand={{productName:branding.product_name,logoUrl:branding.logo_url}} navigationLabel={w('Navigation','导航','導覽')} openNavigationLabel={w('Open navigation','打开导航','開啟導覽')} closeNavigationLabel={w('Close navigation','关闭导航','關閉導覽')} skipLabel={w('Skip to content','跳至内容','跳至內容')} navigationOpen={navigationOpen} onNavigationOpenChange={setNavigationOpen}
    navigation={<WorkspaceNav label={w('Workspace','工作空间','工作空間')} activeKey={route} onSelect={navigate} groups={[{key:'main',label:'',items},{key:'channels',label:w('Channels','频道','頻道'),items:session.channels.filter(channel=>!channel.archived).map(channel=>({key:`channel-${channel.id}`,label:channel.name,icon:<Glyph name="channel" />}))}]} />}
    account={<><span>{session.user.display_name || session.user.username}</span><Button type="text" aria-label={w('Sign out','退出登录','登出')} icon={<Glyph name="logout" />} onClick={() => void logout()} /></>} utilities={<Utilities />}>
    {error && <Notice tone="danger" title={error} />}
    {!allowed ? <Notice tone="warning" title={w('You do not have access to this area.','您无权访问此区域。','您無權存取此區域。')} /> : scope ? <Conversation key={scope} scope={scope} title={scope === 'private' ? undefined : session.channels.find(channel=>`channel-${channel.id}` === scope)?.name} canSend={scope === 'private' || chatAccess} /> : route === 'chat' ? <Chat /> : route === 'channels' ? <Channels channels={session.channels} onChange={channels=>setSession({...session,channels})} onOpen={navigate} permissions={session.permissions} admin={admin} /> : route === 'schedules' ? <Schedules /> : route === 'admin' && admin ? <Admin /> : <Settings user={session.user} onSaved={user=>setSession({...session,user})} />}
  </AppFrame>;
}

export default function App() {
  return <I18nProvider><BrandingProvider><ThemeProvider><AntDesignProvider><Shell /></AntDesignProvider></ThemeProvider></BrandingProvider></I18nProvider>;
}
