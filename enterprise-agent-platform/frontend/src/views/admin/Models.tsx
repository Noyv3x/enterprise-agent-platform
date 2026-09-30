import { useEffect, useState } from 'react';
import { Button, Popconfirm, Typography } from 'antd';
import { request } from '../../api';
import { useWords } from '../../words';
import { DataRegion, EmptyState, FormFooter, Notice, ResourceList, ResourceRow, Section, StatusMark } from '../../components/ui/fieldwork';
import { errorText, formatTime, useResource, type ModelCatalog } from './shared';

interface OAuthFlow { flow_id: string; provider: string; kind: string; status: 'waiting_for_user' | 'complete'; complete: boolean; expires_at: string; verification_url: string; user_code: string; poll_interval: number }

export function Models() {
  const w = useWords();
  const catalog = useResource<ModelCatalog>('/api/admin/models');
  const [flow, setFlow] = useState<OAuthFlow | null>(null);
  const [busy, setBusy] = useState<'start' | 'poll' | 'disconnect' | null>(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);

  async function start() {
    setBusy('start'); setError(''); setConnected(false);
    try { setFlow(await request<OAuthFlow>('/api/admin/oauth/start', { method: 'POST', body: '{}' })); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(null); }
  }
  async function poll(current: OAuthFlow) {
    setBusy('poll');
    try {
      const next = await request<OAuthFlow>(`/api/admin/oauth/${encodeURIComponent(current.flow_id)}/poll`, { method: 'POST', body: '{}' });
      if (next.complete || next.status === 'complete') {
        setFlow(null);
        setConnected(true);
        await catalog.reload();
      } else {
        setFlow(next);
      }
    } catch (cause) {
      // Expired (410) and upstream (502) failures end this flow; the admin starts a new one.
      setFlow(null);
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  }
  async function disconnect() {
    setBusy('disconnect'); setError(''); setConnected(false);
    try { await request('/api/admin/oauth', { method: 'DELETE' }); await catalog.reload(); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(null); }
  }
  // The device flow completes in another tab; poll at the interval the provider asked for.
  useEffect(() => {
    if (!flow || busy) return;
    const timer = window.setTimeout(() => void poll(flow), Math.max(flow.poll_interval, 1) * 1000);
    return () => window.clearTimeout(timer);
  }, [flow, busy]);

  const models = catalog.data?.models ?? [];
  const linked = catalog.data?.connected === true;
  return <>
    <Section title={w('Codex account', 'Codex 账户', 'Codex 帳戶')}
      description={w('The platform signs in to OpenAI Codex once; every personal AI, channel, and chat uses this authorization.', '平台只需登录一次 OpenAI Codex；所有个人 AI、频道和聊天都使用此授权。', '平台只需登入一次 OpenAI Codex；所有個人 AI、頻道和聊天都使用此授權。')}
      actions={catalog.data && <StatusMark tone={linked ? 'success' : 'warning'}>{linked ? w('Connected', '已连接', '已連線') : w('Not connected', '未连接', '未連線')}</StatusMark>}>
      {error && <Notice tone="danger" title={error} />}
      {connected && <Notice tone="success" title={w('Codex account connected', 'Codex 账户已连接', 'Codex 帳戶已連線')} />}
      {flow && <Notice tone="info" title={w('Waiting for authorization', '等待授权', '等待授權')}
        action={<Button onClick={() => setFlow(null)} disabled={busy === 'poll'}>{w('Cancel', '取消', '取消')}</Button>}>
        <ol>
          <li>{w('Open the verification page: ', '打开验证页面：', '開啟驗證頁面：')}<Typography.Link href={flow.verification_url} target="_blank" rel="noopener noreferrer">{flow.verification_url}</Typography.Link></li>
          <li>{w('Enter this code: ', '输入以下代码：', '輸入以下代碼：')}<Typography.Text code copyable>{flow.user_code}</Typography.Text></li>
          <li>{w(`This page updates by itself once you approve. The code expires ${formatTime(flow.expires_at)}.`, `授权后此页面会自动更新。代码将于 ${formatTime(flow.expires_at)} 过期。`, `授權後此頁面會自動更新。代碼將於 ${formatTime(flow.expires_at)} 過期。`)}</li>
        </ol>
      </Notice>}
      <FormFooter>
        {linked && <Popconfirm title={w('Disconnect the Codex account?', '断开 Codex 账户？', '中斷 Codex 帳戶連線？')} description={w('All agents stop answering until an account is connected again.', '在重新连接账户之前，所有 Agent 都将无法回复。', '在重新連線帳戶之前，所有 Agent 都將無法回覆。')}
          okText={w('Disconnect', '断开', '中斷連線')} cancelText={w('Cancel', '取消', '取消')} okButtonProps={{ danger: true }} onConfirm={disconnect}>
          <Button danger loading={busy === 'disconnect'} disabled={busy !== null && busy !== 'disconnect'}>{w('Disconnect', '断开', '中斷連線')}</Button>
        </Popconfirm>}
        <Button type={linked ? 'default' : 'primary'} loading={busy === 'start'} disabled={!!flow || (busy !== null && busy !== 'start')} onClick={() => void start()}>
          {linked ? w('Reconnect', '重新连接', '重新連線') : w('Connect Codex account', '连接 Codex 账户', '連線 Codex 帳戶')}
        </Button>
      </FormFooter>
    </Section>
    <Section title={w('Available models', '可用模型', '可用模型')}
      description={w('Choices offered for personal AI models and standard chat policies.', '可用于个人 AI 模型和标准聊天策略的模型。', '可用於個人 AI 模型和標準聊天策略的模型。')}
      actions={<Button onClick={() => void catalog.reload()} loading={catalog.refreshing}>{w('Refresh', '刷新', '重新整理')}</Button>}>
      <DataRegion state={catalog.state === 'ready' && !models.length ? 'empty' : catalog.state} loadingLabel={w('Loading models…', '正在加载模型…', '正在載入模型…')}
        error={catalog.error} retry={<Button onClick={() => void catalog.reload()}>{w('Retry', '重试', '重試')}</Button>} refreshing={catalog.refreshing}
        empty={<EmptyState compact title={w('No models yet', '暂无模型', '尚無模型')} description={linked ? w('The provider returned no models. Try refreshing.', '供应商没有返回模型，请尝试刷新。', '供應商沒有回傳模型，請嘗試重新整理。') : w('Connect a Codex account to load its models.', '连接 Codex 账户后即可加载模型。', '連線 Codex 帳戶後即可載入模型。')} />}>
        <ResourceList label={w('Available models', '可用模型', '可用模型')}>
          {models.map((model) => <ResourceRow key={model.id} title={model.name || model.id} description={model.name && model.name !== model.id ? <code>{model.id}</code> : undefined} />)}
        </ResourceList>
      </DataRegion>
    </Section>
  </>;
}
