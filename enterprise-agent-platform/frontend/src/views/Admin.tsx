import { useState } from 'react';
import { useWords } from '../words';
import { PageHeader, PageLayout, SectionIndex } from '../components/ui/fieldwork';
import { BrandingSettings } from './admin/Branding';
import { Groups } from './admin/Groups';
import { Models } from './admin/Models';
import { System } from './admin/System';
import { Usage } from './admin/Usage';
import { Users } from './admin/Users';

type Page = 'users' | 'groups' | 'usage' | 'models' | 'branding' | 'system';

export function Admin() {
  const w = useWords();
  const [page, setPage] = useState<Page>('users');
  const pages: Record<Page, { label: string; description: string }> = {
    users: { label: w('Accounts', '账户', '帳戶'), description: w('Accounts, personal AI models, and standard chat model policies.', '账户、个人 AI 模型与标准聊天模型策略。', '帳戶、個人 AI 模型與標準聊天模型策略。') },
    groups: { label: w('Permission groups', '权限组', '權限群組'), description: w('What each group of accounts is allowed to use.', '每个权限组可以使用的功能。', '每個權限群組可以使用的功能。') },
    usage: { label: w('Token usage', 'Token 用量', 'Token 用量'), description: w('Token consumption and prompt-cache efficiency.', 'Token 消耗与提示缓存效率。', 'Token 消耗與提示快取效率。') },
    models: { label: w('Models & authorization', '模型与授权', '模型與授權'), description: w('Codex sign-in and the models it provides.', 'Codex 登录及其提供的模型。', 'Codex 登入及其提供的模型。') },
    branding: { label: w('Branding', '品牌设置', '品牌設定'), description: w('Product name, agent name, primary color, and logo.', '产品名称、Agent 名称、主色与 Logo。', '產品名稱、Agent 名稱、主色與 Logo。') },
    system: { label: w('System & updates', '系统与更新', '系統與更新'), description: w('Release status, service health, and automatic updates.', '版本状态、服务健康与自动更新。', '版本狀態、服務健康與自動更新。') },
  };
  const item = (key: Page) => ({ key, label: pages[key].label });

  return <PageLayout
    header={<PageHeader eyebrow={w('Administration', '管理', '管理')} title={pages[page].label} description={pages[page].description} />}
    navigation={<SectionIndex label={w('Administration navigation', '管理导航', '管理導覽')} activeKey={page} onSelect={(key) => setPage(key as Page)}
      groups={[
        { key: 'people', label: w('People & activity', '成员与活动', '成員與活動'), items: [item('users'), item('groups'), item('usage')] },
        { key: 'ai', label: w('AI & connections', 'AI 与连接', 'AI 與連線'), items: [item('models')] },
        { key: 'deployment', label: w('Deployment', '部署管理', '部署管理'), items: [item('branding'), item('system')] },
      ]} />}>
    {page === 'users' && <Users />}
    {page === 'groups' && <Groups />}
    {page === 'usage' && <Usage />}
    {page === 'models' && <Models />}
    {page === 'branding' && <BrandingSettings />}
    {page === 'system' && <System />}
  </PageLayout>;
}
