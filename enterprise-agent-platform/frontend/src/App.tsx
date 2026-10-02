import { useCallback, useEffect, useState } from 'react';
import { ApiError, request, type User } from './api';
import { Button } from './components/ui/beautiful/atoms/Button';
import { Notice, PageHeader } from './components/ui/beautiful/controls';
import LoadingState from './components/ui/beautiful/primitives/LoadingState';
import { BrandingProvider } from './context/BrandingContext';
import { ThemeProvider } from './context/ThemeContext';
import { I18nProvider } from './i18n';
import { AppFrame } from './shell/AppFrame';
import { Login } from './shell/Login';
import { PreferenceCorner } from './shell/preferences';
import { accessFor, allowed, homeRoute, parseRoute } from './shell/routes';
import { Sidebar } from './shell/Sidebar';
import { useWords } from './words';
import { Admin } from './views/Admin';
import { Channels, type Channel } from './views/Channels';
import { Chat } from './views/Chat';
import { Conversation } from './views/Conversation';
import { Settings } from './views/Settings';
import { setChatAccount } from './views/chat/chatStore';

export { Login } from './shell/Login';

interface Bootstrap { user: User; permissions: string[]; channels: Channel[] }

const COLLAPSED_KEY = 'eap-sidebar-collapsed';

function readCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
}

function currentHash(): string {
  return location.hash.slice(1);
}

function Shell() {
  const w = useWords();
  const [session, setSession] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hash, setHash] = useState(currentHash);
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const bootstrap = useCallback(async () => {
    try {
      const next = await request<Bootstrap>('/api/bootstrap');
      setChatAccount(next.user.id);
      setSession(next);
      setError('');
    }
    catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) { setChatAccount(null); setSession(null); }
      else throw cause;
    }
  }, []);
  useEffect(() => { void bootstrap().catch(cause => setError(cause.message)).finally(() => setLoading(false)); }, [bootstrap]);
  useEffect(() => {
    const changed = () => setHash(currentHash());
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  useEffect(() => {
    const expired = () => { setChatAccount(null); setSession(null); };
    window.addEventListener('session-expired', expired);
    return () => window.removeEventListener('session-expired', expired);
  }, []);

  const navigate = useCallback((key: string) => { location.hash = key; setHash(key); }, []);
  const changeCollapsed = (next: boolean) => {
    setCollapsed(next);
    try { localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0'); } catch { /* the choice still holds for this page */ }
  };
  async function logout() {
    try { await request('/api/auth/logout', { method: 'POST', body: '{}' }); setChatAccount(null); setSession(null); navigate(''); }
    catch (cause) { setError((cause as Error).message); }
  }

  const access = session ? accessFor(session.user.role, session.permissions) : null;
  // A bare or unknown address opens the first area this session may use.
  useEffect(() => {
    if (access && (hash === '' || parseRoute(hash).view === 'unknown')) {
      const home = homeRoute(access);
      history.replaceState(null, '', `#${home}`);
      setHash(home);
    }
  }, [access, hash]);

  if (loading) {
    return <div className="flex h-[100dvh] items-center justify-center bg-canvas"><LoadingState label={w('Loading workspace', '正在加载工作空间', '正在載入工作空間')} /></div>;
  }
  if (!session || !access) {
    if (!error) return <Login onLogin={bootstrap} />;
    return (
      <div className="flex min-h-[100dvh] flex-col bg-canvas text-ink">
        <div className="flex justify-end p-2.5"><PreferenceCorner /></div>
        <main className="flex flex-1 items-center justify-center px-4 pb-16">
          <Notice tone="danger" className="w-full max-w-[420px]" title={w('The workspace could not be loaded', '无法加载工作空间', '無法載入工作空間')}
            action={<Button size="sm" variant="secondary" className="touch:h-11" onClick={() => { setError(''); setLoading(true); void bootstrap().catch(cause => setError(cause.message)).finally(() => setLoading(false)); }}>{w('Retry', '重试', '重試')}</Button>}>
            {error}
          </Notice>
        </main>
      </div>
    );
  }

  const route = parseRoute(hash);
  const { user, channels, permissions } = session;
  const userName = user.display_name || user.username;
  const channelName = route.view === 'channel' ? channels.find(channel => channel.id === route.id)?.name : undefined;

  let view;
  if (!allowed(route, access)) {
    view = <>
      <PageHeader title={w('No access', '无权访问', '無權存取')} />
      <div className="p-4"><Notice tone="warning" title={w('You do not have access to this area.', '您无权访问此区域。', '您無權存取此區域。')}>{w('Ask an administrator for the permission, or pick another area in the sidebar.', '请联系管理员开通权限，或在侧栏中选择其他区域。', '請聯絡管理員開通權限，或在側欄中選擇其他區域。')}</Notice></div>
    </>;
  } else if (route.view === 'private') {
    view = <Conversation key="private" scope="private" canSend userId={user.id} userName={userName} />;
  } else if (route.view === 'channel') {
    view = <Conversation key={hash} scope={`channel-${route.id}`} title={channelName} canSend={access.chat} userId={user.id} userName={userName} />;
  } else if (route.view === 'chat') {
    view = <Chat key={route.id ?? 'new'} id={route.id ?? undefined} userName={userName} />;
  } else if (route.view === 'channels') {
    view = <Channels channels={channels} onChange={next => setSession({ ...session, channels: next })} onOpen={navigate} permissions={permissions} admin={access.admin} />;
  } else if (route.view === 'admin') {
    view = <Admin />;
  } else {
    view = <Settings user={user} onSaved={next => setSession({ ...session, user: next })} />;
  }

  return (
    <AppFrame
      routeKey={hash}
      renderSidebar={({ drawer, onClose }) => (
        <Sidebar user={user} channels={channels} access={access} route={route} navigate={navigate} onSignOut={() => void logout()}
          collapsed={collapsed} onCollapsedChange={changeCollapsed} drawer={drawer} onClose={onClose} />
      )}
    >
      {error && <Notice tone="danger" title={error} onDismiss={() => setError('')} className="m-3 mb-0" />}
      {view}
    </AppFrame>
  );
}

export default function App() {
  return <I18nProvider><BrandingProvider><ThemeProvider><Shell /></ThemeProvider></BrandingProvider></I18nProvider>;
}
