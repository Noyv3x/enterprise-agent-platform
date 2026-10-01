import { useEffect, useState } from 'react';
import { PageHeader } from '../components/ui/beautiful/controls';
import { useWords } from '../words';
import { BrandingSettings } from './admin/Branding';
import { Groups } from './admin/Groups';
import { Models } from './admin/Models';
import { System } from './admin/System';
import { Usage } from './admin/Usage';
import { Users } from './admin/Users';

const TABS = ['users', 'groups', 'models', 'branding', 'system', 'usage'] as const;
type Tab = (typeof TABS)[number];

/** `#admin` opens Users; `#admin/<tab>` opens that tab. Unknown tabs fall back to Users. */
function tabFromHash(): Tab {
  const match = /^#admin\/([a-z]+)/.exec(window.location.hash);
  return TABS.find((tab) => tab === match?.[1]) ?? 'users';
}

export function Admin() {
  const w = useWords();
  const [tab, setTab] = useState<Tab>(tabFromHash);
  useEffect(() => {
    const sync = () => setTab(tabFromHash());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const pages: Record<Tab, { label: string; description: string }> = {
    users: { label: w('Accounts', '账户', '帳戶'), description: w('Who can sign in, their access, personal AI model and chat model policy.', '谁可以登录、访问权限、个人 AI 模型和聊天模型策略。', '誰可以登入、存取權限、個人 AI 模型和聊天模型策略。') },
    groups: { label: w('Permission groups', '权限组', '權限群組'), description: w('Each account belongs to one group; the group decides which workspace features it can use.', '每个账户属于一个权限组，权限组决定可使用的工作区功能。', '每個帳戶屬於一個權限群組，權限群組決定可使用的工作區功能。') },
    models: { label: w('Models', '模型', '模型'), description: w('Codex sign-in and the models it provides to every agent and chat.', 'Codex 登录及其为所有 Agent 和聊天提供的模型。', 'Codex 登入及其為所有 Agent 和聊天提供的模型。') },
    branding: { label: w('Branding', '品牌', '品牌'), description: w('Product name, agent name, accent color and logo shown to everyone.', '对所有人显示的产品名称、Agent 名称、强调色和 Logo。', '對所有人顯示的產品名稱、Agent 名稱、強調色和 Logo。') },
    system: { label: w('System', '系统', '系統'), description: w('Release, service health and updates installed by the host Manager.', '由宿主机管理器安装的版本、服务健康状态和更新。', '由主機管理器安裝的版本、服務健康狀態和更新。') },
    usage: { label: w('Usage', '用量', '用量'), description: w('Token consumption and prompt-cache efficiency across personal AI, channels and chat.', '个人 AI、频道和聊天的 Token 消耗与提示缓存效率。', '個人 AI、頻道和聊天的 Token 消耗與提示快取效率。') },
  };

  return <div className="flex min-h-0 flex-1 flex-col">
    <PageHeader
      title={w('Administration', '管理', '管理')}
      description={pages[tab].description}
      tabs={TABS.map((key) => ({ key, label: pages[key].label }))}
      activeTab={tab}
      onTabChange={(key: string) => { setTab(key as Tab); window.location.hash = key === 'users' ? 'admin' : `admin/${key}`; }}
    />
    {/* the record tables fill the window; the other tabs scroll */}
    <div className={tab === 'users' || tab === 'groups' ? 'flex min-h-0 flex-1 flex-col' : 'min-h-0 flex-1 overflow-y-auto'}>
      {tab === 'users' && <Users />}
      {tab === 'groups' && <Groups />}
      {tab === 'models' && <Models />}
      {tab === 'branding' && <BrandingSettings />}
      {tab === 'system' && <System />}
      {tab === 'usage' && <Usage />}
    </div>
  </div>;
}
