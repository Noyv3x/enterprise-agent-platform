import { useEffect, useRef, useState } from 'react';
import { request } from '../../api';
import { Button } from '../../components/ui/beautiful/atoms/Button';
import { Chip } from '../../components/ui/beautiful/atoms/Chip';
import { StatusPill } from '../../components/ui/beautiful/atoms/StatusPill';
import { Switch } from '../../components/ui/beautiful/atoms/Switch';
import { ConfirmDialog, DescriptionList, Field, FormActions, FormSection, Icon, Notice, TextField } from '../../components/ui/beautiful/controls';
import LoadingState from '../../components/ui/beautiful/primitives/LoadingState';
import TaskRows, { type TaskRow } from '../../components/ui/beautiful/primitives/TaskRows';
import { useWords } from '../../words';
import { errorText, formatTime, operationKey, useResource } from './shared';

/** Manager `/v1/status`, forwarded unchanged by Platform. */
interface Generation { id: string; source_commit: string; database_version: number; images: Record<string, string>; activated_at: string | null }
interface ManagerStatus {
  generation: number;
  current: Generation | null;
  previous: Generation | null;
  target: Generation | null;
  public_state: 'idle' | 'waiting_for_tasks' | 'updating' | 'failed';
  phase: string;
  services: Record<string, { status: string }>;
  error: string;
  operation_id: string;
  checked_at: string | null;
}
/** Manager `/v1/config` public projection; only update fields are edited here. */
interface ManagerConfig { update_enabled: boolean; update_interval: number; release_manifest_url: string }
type Operation = 'update' | 'restart' | 'rollback' | 'repair';

/** Manager operation phases in the order an update walks them; restarts and repairs skip some. */
const PHASES = ['validating', 'pulling', 'preparing', 'draining', 'snapshotting', 'migrating', 'starting', 'probing', 'committing'] as const;
const SERVICE_TONE: Record<string, 'green' | 'accent' | 'red' | 'neutral'> = { healthy: 'green', starting: 'accent', unavailable: 'red', unknown: 'neutral' };

export function System() {
  const w = useWords();
  const status = useResource<ManagerStatus>('/api/admin/system');
  const config = useResource<ManagerConfig>('/api/admin/system/config');
  const [busy, setBusy] = useState<Operation | 'check' | 'config' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<Operation | null>(null);
  const [draft, setDraft] = useState<ManagerConfig | null>(null);
  useEffect(() => { if (config.data) setDraft(config.data); }, [config.data]);

  const data = status.data;
  const running = data?.public_state === 'updating' || data?.public_state === 'waiting_for_tasks' || !!data?.operation_id;
  // Poll quietly: fast while an operation runs, slow otherwise; skip hidden tabs.
  const runningRef = useRef(running);
  runningRef.current = running;
  const reloadStatus = status.reload;
  useEffect(() => {
    let timer = 0;
    let stopped = false;
    const tick = async () => {
      if (!document.hidden) await reloadStatus(true);
      if (!stopped) timer = window.setTimeout(tick, runningRef.current ? 2000 : 10000);
    };
    timer = window.setTimeout(tick, runningRef.current ? 2000 : 10000);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [reloadStatus]);

  const blocked = !data || !!status.error || running || busy !== null;
  const updateAvailable = !!data?.target?.id && data.target.id !== data.current?.id;
  const stateLabel: Record<ManagerStatus['public_state'], string> = {
    idle: w('Idle', '待命', '待命'),
    waiting_for_tasks: w('Waiting for running tasks to finish', '等待运行中的任务结束', '等待執行中的任務結束'),
    updating: w('Updating', '正在更新', '正在更新'),
    failed: w('Needs attention', '需要处理', '需要處理'),
  };
  const serviceLabel: Record<string, string> = {
    healthy: w('Healthy', '正常', '正常'),
    starting: w('Starting', '启动中', '啟動中'),
    unavailable: w('Unavailable', '不可用', '無法使用'),
    unknown: w('Unknown', '未知', '未知'),
  };
  const phaseLabel: Record<string, string> = {
    validating: w('Validate the release', '校验版本', '校驗版本'),
    pulling: w('Download images', '下载镜像', '下載映像'),
    preparing: w('Prepare services', '准备服务', '準備服務'),
    draining: w('Let running agent work finish', '等待 Agent 任务结束', '等待 Agent 任務結束'),
    snapshotting: w('Snapshot data', '数据快照', '資料快照'),
    migrating: w('Migrate the database', '迁移数据库', '遷移資料庫'),
    starting: w('Start services', '启动服务', '啟動服務'),
    probing: w('Check service health', '检查服务健康', '檢查服務健康'),
    committing: w('Activate the release', '启用新版本', '啟用新版本'),
    rolling_back: w('Roll back to the previous release', '回滚到上一个版本', '回滾到上一個版本'),
  };

  async function check() {
    setBusy('check'); setError(''); setNotice('');
    try {
      await request('/api/admin/system/check', { method: 'POST', body: JSON.stringify({ idempotency_key: operationKey() }) });
      await status.reload(true);
      setNotice(w('Update check finished.', '更新检查已完成。', '更新檢查已完成。'));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  }
  async function operate(operation: Operation) {
    if (!data) return;
    setBusy(operation); setError(''); setNotice('');
    try {
      await request('/api/admin/system/operations', { method: 'POST', body: JSON.stringify({ operation, idempotency_key: operationKey(), expected_generation: data.generation }) });
      await status.reload(true);
      setConfirm(null);
    } catch (cause) {
      setError(errorText(cause));
      setConfirm(null);
    } finally {
      setBusy(null);
    }
  }
  async function saveConfig() {
    if (!draft || !config.data) return;
    setBusy('config'); setError(''); setNotice('');
    try {
      const body: Partial<ManagerConfig> = {};
      if (draft.update_enabled !== config.data.update_enabled) body.update_enabled = draft.update_enabled;
      if (draft.update_interval !== config.data.update_interval) body.update_interval = draft.update_interval;
      if (draft.release_manifest_url !== config.data.release_manifest_url) body.release_manifest_url = draft.release_manifest_url.trim();
      config.setData(await request<ManagerConfig>('/api/admin/system/config', { method: 'PATCH', body: JSON.stringify(body) }));
      setNotice(w('Update settings saved.', '更新设置已保存。', '更新設定已儲存。'));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  }
  const configDirty = !!draft && !!config.data && (draft.update_enabled !== config.data.update_enabled || draft.update_interval !== config.data.update_interval || draft.release_manifest_url !== config.data.release_manifest_url);
  const intervalValid = !!draft && Number.isInteger(draft.update_interval) && draft.update_interval >= 30 && draft.update_interval <= 86400;

  /* Operation progress: phases before the reported one are done, the reported one runs (or failed). */
  const progress: TaskRow[] = [];
  if (data && (running || data.public_state === 'failed') && data.phase) {
    if (data.phase === 'rolling_back') {
      progress.push({ key: 'rolling_back', label: phaseLabel.rolling_back, status: data.public_state === 'failed' ? 'failed' : 'running', step: 1, pill: null, details: [] });
    } else {
      const at = PHASES.indexOf(data.phase as (typeof PHASES)[number]);
      PHASES.forEach((phase, index) => progress.push({
        key: phase,
        label: phaseLabel[phase],
        status: index < at ? 'done' : index === at ? (data.public_state === 'failed' ? 'failed' : 'running') : 'pending',
        step: index + 1,
        pill: index < at ? null : undefined,
        details: index === at && data.error ? [{ label: w('Error', '错误', '錯誤'), meta: data.error, wide: true }] : [],
      }));
    }
  }

  const confirmCopy: Record<Operation, { title: string; description: string; label: string; danger: boolean }> = {
    update: { title: w(`Install ${data?.target?.id ?? 'the update'}?`, `安装 ${data?.target?.id ?? '更新'}？`, `安裝 ${data?.target?.id ?? '更新'}？`), description: w('Running agent work finishes first, then services restart on the new release. Users briefly lose the connection.', '会先等待运行中的 Agent 任务结束，然后服务以新版本重启。用户会短暂断开连接。', '會先等待執行中的 Agent 任務結束，然後服務以新版本重新啟動。使用者會短暫中斷連線。'), label: w('Install update', '安装更新', '安裝更新'), danger: false },
    rollback: { title: w('Roll back to the previous release?', '回滚到上一个版本？', '回滾到上一個版本？'), description: w('Services restart and data returns to the snapshot taken before the last update. Changes since then are lost.', '服务将重启，数据会恢复到上次更新前的快照，之后的更改会丢失。', '服務將重新啟動，資料會恢復到上次更新前的快照，之後的變更會遺失。'), label: w('Roll back', '回滚', '回滾'), danger: true },
    restart: { title: w('Restart all services?', '重启所有服务？', '重新啟動所有服務？'), description: w('Running agent work finishes first; users briefly lose the connection.', '会先等待运行中的 Agent 任务结束，用户会短暂断开连接。', '會先等待執行中的 Agent 任務結束，使用者會短暫中斷連線。'), label: w('Restart services', '重启服务', '重新啟動服務'), danger: true },
    repair: { title: w('Repair the installation?', '修复安装？', '修復安裝？'), description: w('The Manager re-applies the current release and restarts services.', '管理器会重新应用当前版本并重启服务。', '管理器會重新套用目前版本並重新啟動服務。'), label: w('Repair', '修复', '修復'), danger: false },
  };
  const stateTone = data?.public_state === 'failed' ? 'red' : data?.public_state === 'idle' ? (updateAvailable ? 'accent' : 'green') : 'orange';
  const short = (commit?: string) => commit ? <Chip>{commit.slice(0, 12)}</Chip> : null;

  return <div className="flex max-w-[880px] flex-col gap-4 p-4 sm:p-6">
    {error && <Notice tone="danger" title={w('That did not work', '操作未成功', '操作未成功')}>{error}</Notice>}
    {notice && <Notice tone="success" title={notice} />}

    <FormSection
      title={w('Release', '版本', '版本')}
      description={w('The host Manager installs releases, restarts services and rolls back to the previous verified release.', '宿主机管理器负责安装版本、重启服务，并可回滚到上一个已验证的版本。', '主機管理器負責安裝版本、重新啟動服務，並可回滾到上一個已驗證的版本。')}
      actions={data && <StatusPill tone={stateTone}>{stateLabel[data.public_state] ?? data.public_state}</StatusPill>}
      footer={data && <FormActions status={data.checked_at ? w(`Manager heartbeat ${formatTime(data.checked_at)}`, `管理器心跳 ${formatTime(data.checked_at)}`, `管理器心跳 ${formatTime(data.checked_at)}`) : undefined}>
        <Button size="sm" disabled={blocked} onClick={() => void check()}>{busy === 'check' ? w('Checking…', '正在检查…', '正在檢查…') : w('Check for updates', '检查更新', '檢查更新')}</Button>
        {data.public_state === 'failed' && <Button size="sm" disabled={blocked} onClick={() => setConfirm('repair')}>{w('Repair', '修复', '修復')}</Button>}
        <Button size="sm" disabled={blocked || !data.previous} onClick={() => setConfirm('rollback')}>{w('Roll back', '回滚', '回滾')}</Button>
        <Button size="sm" disabled={blocked} onClick={() => setConfirm('restart')}>{w('Restart services', '重启服务', '重新啟動服務')}</Button>
        <Button size="sm" variant="primary" disabled={blocked || !updateAvailable} onClick={() => setConfirm('update')}>{w('Install update', '安装更新', '安裝更新')}</Button>
      </FormActions>}
    >
      {status.state === 'loading' && <LoadingState label={w('Contacting the Manager…', '正在连接管理器…', '正在連線管理器…')} />}
      {status.error && <Notice tone="danger" title={w('Manager unavailable', '管理器不可用', '管理器無法使用')} action={<Button size="sm" onClick={() => void status.reload()}>{w('Retry', '重试', '重試')}</Button>}>{status.error}</Notice>}
      {data && <>
        {data.public_state === 'failed' && <Notice tone="danger" title={w('The last operation failed', '上一次操作失败', '上一次操作失敗')}>{data.error || w('Try Repair, or roll back to the previous release.', '请尝试修复，或回滚到上一个版本。', '請嘗試修復，或回滾到上一個版本。')}</Notice>}
        {data.public_state === 'idle' && updateAvailable && <Notice tone="info" title={w(`Release ${data.target?.id} is ready to install.`, `版本 ${data.target?.id} 可以安装。`, `版本 ${data.target?.id} 可以安裝。`)} />}
        <DescriptionList items={[
          { key: 'current', label: w('Current release', '当前版本', '目前版本'), value: <span className="flex min-w-0 flex-wrap items-center gap-1.5 [overflow-wrap:anywhere]">{data.current?.id || '—'}{short(data.current?.source_commit)}</span> },
          { key: 'activated', label: w('Activated', '启用时间', '啟用時間'), value: formatTime(data.current?.activated_at) },
          { key: 'target', label: w('Available release', '可用版本', '可用版本'), value: <span className="flex min-w-0 flex-wrap items-center gap-1.5 [overflow-wrap:anywhere]">{data.target?.id || '—'}{updateAvailable && short(data.target?.source_commit)}</span> },
          { key: 'previous', label: w('Previous release', '上一个版本', '上一個版本'), value: <span className="[overflow-wrap:anywhere]">{data.previous?.id || '—'}</span> },
          { key: 'generation', label: w('Generation', '代次', '世代'), value: <span className="tabular-nums">{data.generation}</span> },
          { key: 'database', label: w('Database version', '数据库版本', '資料庫版本'), value: <span className="tabular-nums">{data.current?.database_version ?? '—'}</span> },
        ]} />
      </>}
    </FormSection>

    {progress.length > 0 && <section aria-label={w('Operation progress', '操作进度', '操作進度')} className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-medium text-ink">{w('Operation progress', '操作进度', '操作進度')}</h2>
        {data?.operation_id && <span className="truncate font-mono text-[11.5px] text-ink-2">{data.operation_id}</span>}
      </div>
      <TaskRows variant="List" rows={progress} ariaLabel={w('Operation progress', '操作进度', '操作進度')}
        labels={{ completed: w('Done', '完成', '完成'), failed: w('Failed', '失败', '失敗') }} />
    </section>}

    {data && <FormSection title={w('Services', '服务', '服務')}>
      <ul aria-label={w('Services', '服务', '服務')} className="-my-1 flex flex-col divide-y divide-line">
        {Object.entries(data.services).map(([name, service]) => <li key={name} className="flex items-center justify-between gap-3 py-2">
          <span className="font-mono text-[12.5px] text-ink">{name}</span>
          <StatusPill tone={SERVICE_TONE[service.status] ?? 'neutral'}>{serviceLabel[service.status] ?? service.status}</StatusPill>
        </li>)}
      </ul>
      {data.current && Object.keys(data.current.images).length > 0 && <details className="group">
        <summary className="flex cursor-pointer items-center gap-1 text-[12.5px] text-ink-2 hover:text-ink touch:min-h-11">
          <Icon name="chevronRight" size={13} className="transition-transform duration-200 group-open:rotate-90" />
          {w(`Images in the current release (${Object.keys(data.current.images).length})`, `当前版本的镜像（${Object.keys(data.current.images).length}）`, `目前版本的映像（${Object.keys(data.current.images).length}）`)}
        </summary>
        <dl className="mt-2 grid gap-1.5">
          {Object.entries(data.current.images).map(([name, image]) => <div key={name} className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:gap-3">
            <dt className="w-32 shrink-0 text-[12px] text-ink-2">{name}</dt>
            <dd className="min-w-0 truncate font-mono text-[11.5px] text-ink-2" title={image}>{image}</dd>
          </div>)}
        </dl>
      </details>}
    </FormSection>}

    <FormSection
      title={w('Automatic updates', '自动更新', '自動更新')}
      description={w('The Manager checks the release manifest on this interval and installs new releases when no agent work is running.', '管理器按此间隔检查版本清单，并在没有 Agent 任务运行时安装新版本。', '管理器依此間隔檢查版本清單，並在沒有 Agent 任務執行時安裝新版本。')}
      onSubmit={() => { if (configDirty && intervalValid) void saveConfig(); }}
      footer={draft && <FormActions status={configDirty ? w('Unsaved changes', '有未保存的更改', '有未儲存的變更') : undefined}>
        <Button size="sm" type="button" disabled={!configDirty || busy === 'config'} onClick={() => config.data && setDraft(config.data)}>{w('Discard', '放弃', '放棄')}</Button>
        <Button size="sm" variant="primary" type="submit" disabled={!configDirty || !intervalValid || busy === 'config'}>{busy === 'config' ? w('Saving…', '正在保存…', '正在儲存…') : w('Save update settings', '保存更新设置', '儲存更新設定')}</Button>
      </FormActions>}
    >
      {config.state === 'loading' && <LoadingState label={w('Loading update settings…', '正在加载更新设置…', '正在載入更新設定…')} />}
      {config.state === 'error' && <Notice tone="danger" title={w('Update settings unavailable', '无法加载更新设置', '無法載入更新設定')} action={<Button size="sm" type="button" onClick={() => void config.reload()}>{w('Retry', '重试', '重試')}</Button>}>{config.error}</Notice>}
      {draft && <>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <span id="system-auto-update" className="text-[13px] text-ink">{w('Install updates automatically', '自动安装更新', '自動安裝更新')}</span>
            <p className="text-[12px] text-ink-2">{w('Off: new releases wait for Install update.', '关闭时，新版本需手动点击“安装更新”。', '關閉時，新版本需手動點選「安裝更新」。')}</p>
          </div>
          <Switch label={w('Install updates automatically', '自动安装更新', '自動安裝更新')} checked={draft.update_enabled} onChange={(update_enabled) => setDraft({ ...draft, update_enabled })} />
        </div>
        <div className="grid gap-3 sm:grid-cols-[200px_minmax(0,1fr)]">
          <Field label={w('Check interval (seconds)', '检查间隔（秒）', '檢查間隔（秒）')} hint={w('30 to 86400 seconds.', '30 到 86400 秒。', '30 到 86400 秒。')}
            error={intervalValid ? undefined : w('Use a whole number from 30 to 86400.', '请输入 30 到 86400 之间的整数。', '請輸入 30 到 86400 之間的整數。')}>
            <TextField inputMode="numeric" value={String(Number.isNaN(draft.update_interval) ? '' : draft.update_interval)}
              onChange={(event) => setDraft({ ...draft, update_interval: event.target.value.trim() === '' ? Number.NaN : Number(event.target.value) })} />
          </Field>
          <Field label={w('Release manifest URL', '版本清单地址', '版本清單網址')}>
            <TextField value={draft.release_manifest_url} spellCheck={false} onChange={(event) => setDraft({ ...draft, release_manifest_url: event.target.value })} />
          </Field>
        </div>
      </>}
    </FormSection>

    {confirm && <ConfirmDialog
      open
      tone={confirmCopy[confirm].danger ? 'danger' : 'default'}
      title={confirmCopy[confirm].title}
      description={confirmCopy[confirm].description}
      confirmLabel={confirmCopy[confirm].label}
      busy={busy === confirm}
      onConfirm={() => void operate(confirm)}
      onCancel={() => setConfirm(null)}
    />}
  </div>;
}
