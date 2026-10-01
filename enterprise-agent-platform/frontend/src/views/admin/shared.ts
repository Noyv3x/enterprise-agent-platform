import { useCallback, useEffect, useState } from 'react';
import { request } from '../../api';
import { intlLocale } from '../../i18n';
import { useWords } from '../../words';

export interface ModelOption { id: string; name: string }
export interface ModelCatalog { models: ModelOption[]; connected: boolean }
export interface PermissionGroup { name: string; permissions: string[] }
export interface ChatModelPolicy { allowed_models: string[]; default_model_id: string }

export const THINKING_DEPTHS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export const PERMISSIONS = ['read_workspace', 'chat', 'private_agent', 'manage_channels', 'manage_users', 'system_settings'] as const;

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Idempotency keys for Manager calls; also works on plain-HTTP LAN origins where crypto.randomUUID is unavailable. */
export function operationKey(): string {
  return `admin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function formatNumber(value: number | undefined): string {
  return typeof value === 'number' ? new Intl.NumberFormat(intlLocale()).format(value) : '—';
}

/** ISO strings and epoch seconds (OAuth `expires_at`) both render as local date-time in the interface language,
 * in the same medium-date/short-time style as schedules. */
export function formatTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** One GET endpoint as local state. `reload(true)` refreshes without flagging the region as loading (background polling). */
export function useResource<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      setData(await request<T>(path));
      setError('');
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  const state: 'loading' | 'error' | 'ready' = data !== null ? 'ready' : loading ? 'loading' : 'error';
  return { data, setData, error, loading, reload, state, refreshing: loading && data !== null };
}

export function useAdminLabels() {
  const w = useWords();
  const groups: Record<string, string> = {
    admin: w('Administrator', '管理员', '管理員'),
    manager: w('Manager', '经理', '經理'),
    member: w('Member', '成员', '成員'),
    viewer: w('Viewer', '只读', '唯讀'),
  };
  const depths: Record<string, string> = {
    off: w('Off', '关闭', '關閉'),
    minimal: w('Minimal', '极低', '極低'),
    low: w('Low', '低', '低'),
    medium: w('Medium', '中', '中'),
    high: w('High', '高', '高'),
    xhigh: w('Extra high', '超高', '超高'),
  };
  const permissions: Record<string, string> = {
    read_workspace: w('Read workspace', '读取工作区', '讀取工作區'),
    chat: w('Chat', '聊天', '聊天'),
    private_agent: w('Personal AI', '个人 AI', '個人 AI'),
    manage_channels: w('Manage channels', '管理频道', '管理頻道'),
    manage_users: w('Manage accounts', '管理账户', '管理帳戶'),
    system_settings: w('System settings', '系统设置', '系統設定'),
  };
  return {
    group: (name: string) => groups[name] ?? name,
    depth: (value: string) => depths[value === 'none' ? 'off' : value] ?? value,
    permission: (name: string) => permissions[name] ?? name,
  };
}

/** Shared RecordsTable copy. */
export function useRecordsLabels(table: string) {
  const w = useWords();
  return {
    table,
    count: w('total', '条', '筆'),
    sortBy: (label: string) => w(`Sort by ${label}`, `按${label}排序`, `依${label}排序`),
    resize: (label: string) => w(`Resize ${label} column`, `调整“${label}”列宽`, `調整「${label}」欄寬`),
    open: (name: string) => w(`Open ${name}`, `打开 ${name}`, `開啟 ${name}`),
    options: w('Table options', '表格选项', '表格選項'),
    compact: w('Compact columns', '紧凑列宽', '緊湊欄寬'),
    reset: w('Reset column widths', '重置列宽', '重設欄寬'),
  };
}
