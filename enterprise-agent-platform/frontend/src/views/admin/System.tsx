import { useEffect, useRef, useState } from 'react';
import { Button, Form, Input, InputNumber, Popconfirm, Switch } from 'antd';
import { request } from '../../api';
import { useWords } from '../../words';
import { DataRegion, FactGrid, FormFooter, FormGrid, Notice, ResourceList, ResourceRow, Section, StatusMark, type Tone } from '../../components/ui/fieldwork';
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

const SERVICE_TONE: Record<string, Tone> = { healthy: 'success', starting: 'info', unavailable: 'danger', unknown: 'neutral' };

export function System() {
  const w = useWords();
  const status = useResource<ManagerStatus>('/api/admin/system');
  const config = useResource<ManagerConfig>('/api/admin/system/config');
  const [busy, setBusy] = useState<Operation | 'check' | 'config' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
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
    } catch (cause) {
      setError(errorText(cause));
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
  const confirmProps = { okText: w('Continue', '继续', '繼續'), cancelText: w('Cancel', '取消', '取消'), okButtonProps: { danger: true } };

  return <>
    {error && <Notice tone="danger" title={error} />}
    {notice && <Notice tone="success" title={notice} />}
    <Section title={w('Release', '版本', '版本')}
      description={w('The host Manager installs releases, restarts services, and rolls back to the previous verified release.', '宿主机管理器负责安装版本、重启服务，并可回滚到上一个已验证的版本。', '主機管理器負責安裝版本、重新啟動服務，並可回滾到上一個已驗證的版本。')}
      actions={<Button onClick={() => void status.reload()} loading={status.refreshing}>{w('Refresh', '刷新', '重新整理')}</Button>}>
      <DataRegion state={status.state} loadingLabel={w('Contacting the Manager…', '正在连接管理器…', '正在連線管理器…')}
        error={status.error && w(`Manager unavailable: ${status.error}`, `管理器不可用：${status.error}`, `管理器無法使用：${status.error}`)}
        retry={<Button onClick={() => void status.reload()}>{w('Retry', '重试', '重試')}</Button>} refreshing={status.refreshing}>
        {data && <>
          <Notice tone={data.public_state === 'failed' ? 'danger' : data.public_state === 'idle' ? (updateAvailable ? 'info' : 'neutral') : 'warning'} title={stateLabel[data.public_state] ?? data.public_state}>
            {data.phase && <div>{w(`Phase: ${data.phase}`, `阶段：${data.phase}`, `階段：${data.phase}`)}</div>}
            {data.error && <div>{data.error}</div>}
            {data.public_state === 'failed' && <div>{w('Try Repair, or roll back to the previous release.', '请尝试修复，或回滚到上一个版本。', '請嘗試修復，或回滾到上一個版本。')}</div>}
            {data.public_state === 'idle' && updateAvailable && <div>{w('A new release is ready to install.', '有新版本可以安装。', '有新版本可以安裝。')}</div>}
          </Notice>
          <FactGrid columns={3} items={[
            { key: 'current', label: w('Current release', '当前版本', '目前版本'), value: data.current?.id || '—', hint: data.current?.source_commit ? <code>{data.current.source_commit.slice(0, 12)}</code> : undefined },
            { key: 'activated', label: w('Activated', '启用时间', '啟用時間'), value: formatTime(data.current?.activated_at) },
            { key: 'target', label: w('Available release', '可用版本', '可用版本'), value: data.target?.id || '—', hint: data.target?.source_commit ? <code>{data.target.source_commit.slice(0, 12)}</code> : undefined },
            { key: 'previous', label: w('Previous release', '上一个版本', '上一個版本'), value: data.previous?.id || '—' },
            { key: 'operation', label: w('Running operation', '进行中的操作', '進行中的操作'), value: data.operation_id || '—' },
            { key: 'checked', label: w('Manager heartbeat', '管理器心跳', '管理器心跳'), value: formatTime(data.checked_at) },
          ]} />
          <FormFooter>
            <Button loading={busy === 'check'} disabled={blocked} onClick={() => void check()}>{w('Check for updates', '检查更新', '檢查更新')}</Button>
            {data.public_state === 'failed' && <Button loading={busy === 'repair'} disabled={blocked} onClick={() => void operate('repair')}>{w('Repair', '修复', '修復')}</Button>}
            <Popconfirm title={w('Roll back to the previous release?', '回滚到上一个版本？', '回滾到上一個版本？')} description={w('Services restart and data returns to the snapshot taken before the last update.', '服务将重启，数据会恢复到上次更新前的快照。', '服務將重新啟動，資料會恢復到上次更新前的快照。')} {...confirmProps} disabled={blocked || !data.previous} onConfirm={() => operate('rollback')}>
              <Button danger loading={busy === 'rollback'} disabled={blocked || !data.previous}>{w('Roll back', '回滚', '回滾')}</Button>
            </Popconfirm>
            <Popconfirm title={w('Restart all services?', '重启所有服务？', '重新啟動所有服務？')} description={w('Running agent work finishes first; users briefly lose the connection.', '会先等待运行中的 Agent 任务结束，用户会短暂断开连接。', '會先等待執行中的 Agent 任務結束，使用者會短暫中斷連線。')} {...confirmProps} disabled={blocked} onConfirm={() => operate('restart')}>
              <Button loading={busy === 'restart'} disabled={blocked}>{w('Restart services', '重启服务', '重新啟動服務')}</Button>
            </Popconfirm>
            <Button type="primary" loading={busy === 'update'} disabled={blocked || !updateAvailable} onClick={() => void operate('update')}>{w('Install update', '安装更新', '安裝更新')}</Button>
          </FormFooter>
        </>}
      </DataRegion>
    </Section>
    {data && <Section title={w('Services', '服务', '服務')}>
      <ResourceList label={w('Services', '服务', '服務')}>
        {Object.entries(data.services).map(([name, service]) => <ResourceRow key={name} title={name}
          status={<StatusMark tone={SERVICE_TONE[service.status] ?? 'neutral'}>{serviceLabel[service.status] ?? service.status}</StatusMark>} />)}
      </ResourceList>
    </Section>}
    {data?.current && Object.keys(data.current.images).length > 0 && <Section title={w('Images in the current release', '当前版本的镜像', '目前版本的映像')}>
      <ResourceList label={w('Images in the current release', '当前版本的镜像', '目前版本的映像')}>
        {Object.entries(data.current.images).map(([name, image]) => <ResourceRow key={name} title={name} description={<code>{image}</code>} />)}
      </ResourceList>
    </Section>}
    <Section title={w('Automatic updates', '自动更新', '自動更新')} description={w('The Manager checks the release manifest on this interval and installs new releases when no agent work is running.', '管理器按此间隔检查版本清单，并在没有 Agent 任务运行时安装新版本。', '管理器依此間隔檢查版本清單，並在沒有 Agent 任務執行時安裝新版本。')}>
      <DataRegion state={config.state} loadingLabel={w('Loading update settings…', '正在加载更新设置…', '正在載入更新設定…')} error={config.error}
        retry={<Button onClick={() => void config.reload()}>{w('Retry', '重试', '重試')}</Button>}>
        {draft && <Form layout="vertical" disabled={busy === 'config'} onFinish={() => { if (configDirty) void saveConfig(); }}>
          <FormGrid>
            <Form.Item label={w('Install updates automatically', '自动安装更新', '自動安裝更新')}>
              <Switch aria-label={w('Install updates automatically', '自动安装更新', '自動安裝更新')} checked={draft.update_enabled} onChange={(update_enabled) => setDraft({ ...draft, update_enabled })} />
            </Form.Item>
            <Form.Item label={w('Check interval (seconds)', '检查间隔（秒）', '檢查間隔（秒）')} help={w('30 to 86400 seconds.', '30 到 86400 秒。', '30 到 86400 秒。')}>
              <InputNumber aria-label={w('Check interval (seconds)', '检查间隔（秒）', '檢查間隔（秒）')} min={30} max={86400} precision={0} value={draft.update_interval}
                onChange={(value) => setDraft({ ...draft, update_interval: typeof value === 'number' ? value : draft.update_interval })} />
            </Form.Item>
            <Form.Item label={w('Release manifest URL', '版本清单地址', '版本清單網址')}>
              <Input aria-label={w('Release manifest URL', '版本清单地址', '版本清單網址')} value={draft.release_manifest_url} onChange={(event) => setDraft({ ...draft, release_manifest_url: event.target.value })} />
            </Form.Item>
          </FormGrid>
          <FormFooter>
            <Button disabled={!configDirty || busy === 'config'} onClick={() => config.data && setDraft(config.data)}>{w('Discard changes', '放弃更改', '放棄變更')}</Button>
            <Button type="primary" htmlType="submit" loading={busy === 'config'} disabled={!configDirty}>{w('Save update settings', '保存更新设置', '儲存更新設定')}</Button>
          </FormFooter>
        </Form>}
      </DataRegion>
    </Section>
  </>;
}
