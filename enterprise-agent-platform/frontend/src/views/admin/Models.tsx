import { useEffect, useState } from 'react';
import { request } from '../../api';
import { Button } from '../../components/ui/beautiful/atoms/Button';
import { EntityChip } from '../../components/ui/beautiful/atoms/EntityChip';
import { StatusPill } from '../../components/ui/beautiful/atoms/StatusPill';
import { ConfirmDialog, EmptyState, FormActions, FormSection, Icon, Notice } from '../../components/ui/beautiful/controls';
import LoadingState from '../../components/ui/beautiful/primitives/LoadingState';
import { SpinnerRing } from '../../components/ui/beautiful/primitives/TaskRows';
import { useWords } from '../../words';
import { errorText, formatTime, useResource, type ModelCatalog } from './shared';

/** `expires_at` is epoch seconds. */
interface OAuthFlow { flow_id: string; provider: string; kind: string; status: 'waiting_for_user' | 'complete'; complete: boolean; expires_at: number; verification_url: string; user_code: string; poll_interval: number }

export function Models() {
  const w = useWords();
  const catalog = useResource<ModelCatalog>('/api/admin/models');
  const [flow, setFlow] = useState<OAuthFlow | null>(null);
  const [busy, setBusy] = useState<'start' | 'poll' | 'disconnect' | null>(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);

  async function start() {
    setBusy('start'); setError(''); setConnected(false); setCopied(false);
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
        // A fresh object re-arms the poll timer even when the busy flag flips within one render batch.
        setFlow({ ...next });
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
    try { await request('/api/admin/oauth', { method: 'DELETE' }); await catalog.reload(); setConfirming(false); }
    catch (cause) { setError(errorText(cause)); setConfirming(false); }
    finally { setBusy(null); }
  }
  // The device flow completes in another tab; poll at the interval the provider asked for.
  useEffect(() => {
    if (!flow || busy) return;
    const timer = window.setTimeout(() => void poll(flow), Math.max(flow.poll_interval, 1) * 1000);
    return () => window.clearTimeout(timer);
  }, [flow, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const models = catalog.data?.models ?? [];
  const linked = catalog.data?.connected === true;
  return <div className="flex max-w-[880px] flex-col gap-4 p-4 sm:p-6">
    <FormSection
      title={w('Codex account', 'Codex 账户', 'Codex 帳戶')}
      description={w('The platform signs in to OpenAI Codex once; every personal AI, channel and chat uses this authorization.', '平台只需登录一次 OpenAI Codex；所有个人 AI、频道和聊天都使用此授权。', '平台只需登入一次 OpenAI Codex；所有個人 AI、頻道和聊天都使用此授權。')}
      actions={catalog.data && <StatusPill tone={linked ? 'green' : 'orange'}>{linked ? w('Connected', '已连接', '已連線') : w('Not connected', '未连接', '未連線')}</StatusPill>}
      footer={<FormActions>
        {flow && <Button size="sm" onClick={() => setFlow(null)} disabled={busy === 'poll'}>{w('Cancel sign-in', '取消登录', '取消登入')}</Button>}
        {linked && !flow && <Button size="sm" className="bg-red-tint text-red-ink shadow-none hover:bg-red-tint hover:brightness-95" disabled={busy !== null} onClick={() => setConfirming(true)}>{w('Disconnect', '断开', '中斷連線')}</Button>}
        {!flow && <Button size="sm" variant={linked ? 'secondary' : 'primary'} disabled={busy !== null || catalog.state === 'loading'} onClick={() => void start()}>
          {busy === 'start' ? w('Starting…', '正在开始…', '正在開始…') : linked ? w('Reconnect', '重新连接', '重新連線') : w('Connect Codex account', '连接 Codex 账户', '連線 Codex 帳戶')}
        </Button>}
      </FormActions>}
    >
      {error && <Notice tone="danger" title={w('Authorization failed', '授权失败', '授權失敗')}>{error}</Notice>}
      {connected && <Notice tone="success" title={w('Codex account connected', 'Codex 账户已连接', 'Codex 帳戶已連線')} />}
      {catalog.state === 'loading' && <LoadingState label={w('Checking the connection…', '正在检查连接…', '正在檢查連線…')} />}
      {catalog.state === 'error' && <Notice tone="danger" title={w('Connection status unavailable', '无法获取连接状态', '無法取得連線狀態')} action={<Button size="sm" onClick={() => void catalog.reload()}>{w('Retry', '重试', '重試')}</Button>}>{catalog.error}</Notice>}
      {catalog.data && !flow && <p className="text-[13px] leading-[1.5] text-ink-2">{linked
        ? w(`Signed in. ${models.length} models are available to personal AI and chat.`, `已登录。个人 AI 和聊天可使用 ${models.length} 个模型。`, `已登入。個人 AI 和聊天可使用 ${models.length} 個模型。`)
        : w('No account is connected, so agents cannot answer. Connect an account with the device code sign-in.', '尚未连接账户，Agent 无法回复。请使用设备代码登录连接账户。', '尚未連線帳戶，Agent 無法回覆。請使用裝置代碼登入連線帳戶。')}</p>}
      {flow && <ol aria-label={w('Device sign-in', '设备登录', '裝置登入')} className="flex flex-col gap-3">
        <li className="flex items-start gap-2.5">
          <SpinnerRing>1</SpinnerRing>
          <div className="min-w-0 pt-0.5 text-[13px] text-ink">
            {w('Open the verification page', '打开验证页面', '開啟驗證頁面')}
            <a href={flow.verification_url} target="_blank" rel="noopener noreferrer" className="mt-0.5 flex max-w-full items-center gap-1 text-[12.5px] text-accent-ink underline decoration-[color-mix(in_srgb,currentColor_35%,transparent)] underline-offset-3 hover:text-ink hover:decoration-current">
              <span className="truncate">{flow.verification_url}</span><Icon name="external" size={12} />
            </a>
          </div>
        </li>
        <li className="flex items-start gap-2.5">
          <SpinnerRing>2</SpinnerRing>
          <div className="min-w-0 flex-1 pt-0.5">
            <span className="text-[13px] text-ink">{w('Enter this code', '输入以下代码', '輸入以下代碼')}</span>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <code aria-label={w('Device code', '设备代码', '裝置代碼')} className="rounded-control bg-inset px-3 py-1.5 font-mono text-[20px] font-medium tracking-[0.18em] text-ink shadow-hairline select-all">{flow.user_code}</code>
              <Button size="sm" onClick={() => void copyCode(flow.user_code)}>
                <Icon name={copied ? 'check' : 'copy'} size={14} />{copied ? w('Copied', '已复制', '已複製') : w('Copy code', '复制代码', '複製代碼')}
              </Button>
            </div>
          </div>
        </li>
        <li className="flex items-start gap-2.5" aria-live="polite">
          <SpinnerRing active />
          <div className="min-w-0 pt-0.5">
            <span className="text-[13px] text-ink">{w('Waiting for your approval…', '等待你的授权…', '等待你的授權…')}</span>
            <p className="text-[12px] text-ink-2">{w(
              `Checks every ${Math.max(flow.poll_interval, 1)} s and updates by itself. The code expires ${formatTime(flow.expires_at)}.`,
              `每 ${Math.max(flow.poll_interval, 1)} 秒检查一次，授权后自动更新。代码将于 ${formatTime(flow.expires_at)} 过期。`,
              `每 ${Math.max(flow.poll_interval, 1)} 秒檢查一次，授權後自動更新。代碼將於 ${formatTime(flow.expires_at)} 過期。`)}</p>
          </div>
        </li>
      </ol>}
    </FormSection>

    <FormSection
      title={w('Available models', '可用模型', '可用模型')}
      description={w('Choices offered for personal AI and standard chat models.', '可用于个人 AI 和标准聊天的模型。', '可用於個人 AI 和標準聊天的模型。')}
      actions={<Button size="xs" variant="quiet" disabled={catalog.refreshing} onClick={() => void catalog.reload()}><Icon name="refresh" size={14} />{w('Refresh', '刷新', '重新整理')}</Button>}
    >
      {catalog.state === 'loading' && <LoadingState label={w('Loading models…', '正在加载模型…', '正在載入模型…')} />}
      {catalog.data && (models.length
        ? <ul aria-label={w('Available models', '可用模型', '可用模型')} className="flex flex-wrap gap-1.5">
          {models.map((model) => <li key={model.id} title={model.id}>
            <EntityChip className="mx-0 py-0.5" name={model.name || model.id} color="var(--ink-2)" />
          </li>)}
        </ul>
        : <EmptyState title={w('No models yet', '暂无模型', '尚無模型')} description={linked ? w('The provider returned no models. Try refreshing.', '供应商没有返回模型，请尝试刷新。', '供應商沒有回傳模型，請嘗試重新整理。') : w('Connect a Codex account to load its models.', '连接 Codex 账户后即可加载模型。', '連線 Codex 帳戶後即可載入模型。')} />)}
    </FormSection>

    <ConfirmDialog
      open={confirming}
      tone="danger"
      title={w('Disconnect the Codex account?', '断开 Codex 账户？', '中斷 Codex 帳戶連線？')}
      description={w('All agents stop answering until an account is connected again.', '在重新连接账户之前，所有 Agent 都将无法回复。', '在重新連線帳戶之前，所有 Agent 都將無法回覆。')}
      confirmLabel={w('Disconnect', '断开', '中斷連線')}
      busy={busy === 'disconnect'}
      onConfirm={() => void disconnect()}
      onCancel={() => setConfirming(false)}
    />
  </div>;
}
