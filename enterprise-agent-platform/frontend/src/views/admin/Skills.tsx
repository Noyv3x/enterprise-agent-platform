import { useId, useState } from 'react';
import { request, type AdminSkills, type BuiltinSkill, type OrgSkill } from '../../api';
import { Button } from '../../components/ui/beautiful/atoms/Button';
import { SegmentedControl } from '../../components/ui/beautiful/atoms/SegmentedControl';
import { Switch } from '../../components/ui/beautiful/atoms/Switch';
import { ConfirmDialog, EmptyState, Field, Icon, MultiSelect, Notice } from '../../components/ui/beautiful/controls';
import LoadingState from '../../components/ui/beautiful/primitives/LoadingState';
import RecordsTable, { RecordStatus, RecordTag, RecordTagList, RecordsSearch, RecordsToolbar, type RecordColumn } from '../../components/ui/beautiful/primitives/RecordsTable';
import { useWords } from '../../words';
import { InstallDialog } from '../skills/InstallDialog';
import { SkillSheet } from '../skills/SkillSheet';
import { matches, useSkillLabels } from '../skills/skills';
import { errorText, formatTime, useAdminLabels, useRecordsLabels, useResource } from './shared';

type View = 'org' | 'builtin';
const ALL = '*';
const DANGER_BUTTON = 'bg-red-tint text-red-ink shadow-none hover:bg-red-tint hover:brightness-95';

/** Admin → Skills: organization skills (install, assign to everyone or chosen permission groups, enable, update,
 * delete) and the built-in skills with their organization-wide switches. */
export function Skills() {
  const w = useWords();
  const labels = useSkillLabels();
  const admin = useAdminLabels();
  const data = useResource<AdminSkills>('/api/admin/skills');
  const [view, setView] = useState<View>('org');
  const [query, setQuery] = useState('');
  const [openName, setOpenName] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installGroups, setInstallGroups] = useState<string[]>([ALL]);
  const [switching, setSwitching] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const orgLabels = useRecordsLabels(w('Organization skills', '组织技能', '組織技能'));
  const builtinLabels = useRecordsLabels(w('Built-in skills', '内置技能', '內建技能'));
  const views: Record<View, string> = { org: w('Organization', '组织技能', '組織技能'), builtin: w('Built-in', '内置技能', '內建技能') };

  if (data.state !== 'ready' || !data.data) {
    return <div className="p-4 sm:p-6">
      {data.state === 'loading'
        ? <LoadingState label={w('Loading skills…', '正在加载技能…', '正在載入技能…')} />
        : <Notice tone="danger" title={w('Skills could not be loaded', '无法加载技能', '無法載入技能')} action={<Button size="sm" onClick={() => void data.reload()}>{w('Retry', '重试', '重試')}</Button>}>{data.error}</Notice>}
    </div>;
  }

  const { org, builtin, groups } = data.data;
  const needle = query.trim().toLowerCase();
  const audience = (skill: OrgSkill) => skill.groups.includes(ALL) ? [w('Everyone', '所有人', '所有人')] : skill.groups.map(admin.group);

  async function setBuiltin(skill: BuiltinSkill, enabled: boolean) {
    setSwitching((current) => new Set(current).add(skill.name));
    setNotice(null);
    try {
      await request(`/api/admin/skills/builtin/${encodeURIComponent(skill.name)}`, { method: 'PUT', body: JSON.stringify({ enabled }) });
      data.setData((current) => current && { ...current, builtin: current.builtin.map((item) => item.name === skill.name ? { ...item, org_enabled: enabled } : item) });
    } catch (cause) {
      setNotice({ tone: 'danger', text: errorText(cause) });
    } finally {
      setSwitching((current) => { const next = new Set(current); next.delete(skill.name); return next; });
    }
  }

  const description = <T extends OrgSkill | BuiltinSkill>(): RecordColumn<T> => ({
    key: 'description', label: w('Description', '说明', '說明'), glyph: 'text', width: 340,
    render: (skill) => <span title={skill.description} className="truncate text-ink-2">{skill.description}</span>,
  });
  const version = <T extends OrgSkill | BuiltinSkill>(): RecordColumn<T> => ({
    key: 'version', label: w('Version', '版本', '版本'), glyph: 'json', width: 110,
    sort: (a, b) => (a.version ?? '').localeCompare(b.version ?? ''),
    muted: (skill) => !skill.version,
    render: (skill) => labels.version(skill) ? <span className="font-mono text-[12px]">{labels.version(skill)}</span> : '—',
  });

  const orgColumns: RecordColumn<OrgSkill>[] = [
    description<OrgSkill>(),
    { key: 'groups', label: w('Available to', '可使用的权限组', '可使用的權限群組'), glyph: 'multi', width: 220,
      render: (skill) => <RecordTagList label={w('Available to', '可使用的权限组', '可使用的權限群組')}
        tags={audience(skill).map((label, index) => ({ key: skill.groups[index] ?? label, label, hue: skill.groups.includes(ALL) ? 'neutral' as const : undefined }))} /> },
    { key: 'enabled', label: w('Status', '状态', '狀態'), glyph: 'single', width: 120,
      sort: (a, b) => Number(b.enabled) - Number(a.enabled),
      render: (skill) => <RecordStatus color={skill.enabled ? 'var(--green)' : 'var(--ink-3)'}>{skill.enabled ? w('On', '已启用', '已啟用') : w('Off', '已停用', '已停用')}</RecordStatus> },
    { key: 'source', label: w('Source', '来源', '來源'), glyph: 'url', width: 110,
      render: (skill) => { const tag = labels.source(skill); return tag ? <RecordTag tag={tag} /> : '—'; } },
    version<OrgSkill>(),
    { key: 'updated', label: w('Updated', '更新时间', '更新時間'), glyph: 'date', width: 180,
      sort: (a, b) => (a.updated_at ?? '').localeCompare(b.updated_at ?? ''),
      render: (skill) => <span className="font-mono text-[12px] tabular-nums">{formatTime(skill.updated_at)}</span> },
  ];
  const builtinColumns: RecordColumn<BuiltinSkill>[] = [
    { key: 'org_enabled', label: w('In this organization', '组织内启用', '組織內啟用'), glyph: 'single', width: 160,
      sort: (a, b) => Number(b.org_enabled) - Number(a.org_enabled),
      render: (skill) => <span className="flex items-center gap-2.5">
        <Switch checked={skill.org_enabled} disabled={switching.has(skill.name)} onChange={(enabled) => void setBuiltin(skill, enabled)}
          label={w(`Enable ${skill.name} for everyone`, `为所有人启用 ${skill.name}`, `為所有人啟用 ${skill.name}`)} />
        <span className="text-[12.5px] text-ink-2">{skill.org_enabled ? w('On', '已启用', '已啟用') : w('Off', '已停用', '已停用')}</span>
      </span> },
    description<BuiltinSkill>(),
    version<BuiltinSkill>(),
  ];

  const search = <RecordsSearch value={query} onChange={setQuery} label={w('Search skills', '搜索技能', '搜尋技能')} placeholder={w('Search skill names or descriptions', '搜索技能名称或说明', '搜尋技能名稱或說明')} />;
  const toolbar = <RecordsToolbar
    left={<>
      <SegmentedControl options={[views.org, views.builtin]} value={views[view]} onChange={(label) => { setView(label === views.builtin ? 'builtin' : 'org'); setOpenName(null); }} className="shrink-0 whitespace-nowrap touch:h-11" />
      {search}
    </>}
    right={<>
      <button type="button" className="records-quiet-button" disabled={data.refreshing} onClick={() => void data.reload()}>
        <Icon name="refresh" size={14} />{w('Refresh', '刷新', '重新整理')}
      </button>
      {view === 'org' && <Button size="sm" variant="primary" onClick={() => { setInstallGroups([ALL]); setInstalling(true); }}>
        <Icon name="plus" size={14} />{w('Install skill', '安装技能', '安裝技能')}
      </Button>}
    </>} />;
  const noMatch = w('No skills match the search.', '没有符合搜索的技能。', '沒有符合搜尋的技能。');
  const openedOrg = view === 'org' ? org.find((skill) => skill.name === openName) ?? null : null;
  const openedBuiltin = view === 'builtin' ? builtin.find((skill) => skill.name === openName) ?? null : null;

  return <div className="flex min-h-0 flex-1 flex-col">
    {notice && <Notice tone={notice.tone} title={notice.text} onDismiss={() => setNotice(null)} className="mx-3 mt-3" />}
    {view === 'org' ? <RecordsTable<OrgSkill>
      key="org"
      fill
      rows={org.filter((skill) => matches(skill, needle))}
      rowId={(skill) => skill.name}
      primary={{ label: w('Skill', '技能', '技能'), glyph: 'text', width: 220, name: (skill) => skill.name }}
      columns={orgColumns}
      labels={orgLabels}
      selectedId={openName}
      onOpen={(skill) => setOpenName(skill.name)}
      empty={org.length ? noMatch : <EmptyState icon="sparkle" title={w('No organization skills yet', '还没有组织技能', '還沒有組織技能')}
        description={w('Install a skill from a ZIP or .skill file or a link, then choose which permission groups can use it.', '从 ZIP、.skill 文件或链接安装技能，再选择哪些权限组可以使用。', '從 ZIP、.skill 檔案或連結安裝技能，再選擇哪些權限群組可以使用。')}
        action={<Button size="sm" variant="primary" onClick={() => { setInstallGroups([ALL]); setInstalling(true); }}><Icon name="plus" size={14} />{w('Install skill', '安装技能', '安裝技能')}</Button>} />}
      toolbar={toolbar}
    /> : <RecordsTable<BuiltinSkill>
      key="builtin"
      fill
      rows={builtin.filter((skill) => matches(skill, needle))}
      rowId={(skill) => skill.name}
      primary={{ label: w('Skill', '技能', '技能'), glyph: 'text', width: 220, name: (skill) => skill.name }}
      columns={builtinColumns}
      labels={builtinLabels}
      selectedId={openName}
      onOpen={(skill) => setOpenName(skill.name)}
      empty={builtin.length ? noMatch : <EmptyState title={w('No built-in skills', '没有内置技能', '沒有內建技能')} description={w('This release ships no built-in skills.', '当前版本没有附带内置技能。', '目前版本沒有附帶內建技能。')} />}
      toolbar={toolbar}
    />}

    {openedOrg && <OrgSkillSheet key={openedOrg.name} skill={openedOrg} groups={groups} onClose={() => setOpenName(null)}
      onChanged={(text) => { setNotice({ tone: 'success', text }); void data.reload(true); }}
      onDeleted={(text) => { setOpenName(null); setNotice({ tone: 'success', text }); void data.reload(true); }} />}
    {openedBuiltin && <SkillSheet skill={openedBuiltin} onClose={() => setOpenName(null)} footer={
      <span className="mr-auto flex items-center gap-2.5 text-[12.5px] text-ink">
        <Switch checked={openedBuiltin.org_enabled} disabled={switching.has(openedBuiltin.name)} onChange={(enabled) => void setBuiltin(openedBuiltin, enabled)}
          label={w(`Enable ${openedBuiltin.name} for everyone`, `为所有人启用 ${openedBuiltin.name}`, `為所有人啟用 ${openedBuiltin.name}`)} />
        {openedBuiltin.org_enabled ? w('On for everyone', '已对所有人启用', '已對所有人啟用') : w('Off for everyone', '已对所有人停用', '已對所有人停用')}
      </span>} />}
    <InstallDialog open={installing} onClose={() => setInstalling(false)} endpoint="/api/admin/skills"
      fields={{ groups: installGroups }} ready={installGroups.length > 0}
      onInstalled={(skill) => { setNotice({ tone: 'success', text: w(`${skill.name} is installed for the chosen groups.`, `已安装 ${skill.name}，所选权限组可以使用。`, `已安裝 ${skill.name}，所選權限群組可以使用。`) }); void data.reload(true); }}>
      <GroupAssignment value={installGroups} onChange={setInstallGroups} groups={groups} />
    </InstallDialog>
  </div>;
}

/** Everyone (`["*"]`) or chosen permission groups. */
function GroupAssignment({ value, onChange, groups, disabled = false }: { value: string[]; onChange: (value: string[]) => void; groups: string[]; disabled?: boolean }) {
  const w = useWords();
  const admin = useAdminLabels();
  const everyone = w('Everyone', '所有人', '所有人');
  const chosen = w('Chosen groups', '指定权限组', '指定權限群組');
  const all = value.includes(ALL);
  // Groups the skill names that no longer exist stay visible so the administrator can remove them.
  const options = Array.from(new Set([...groups, ...value.filter((group) => group !== ALL)]));
  return <Field group label={w('Available to', '可使用的权限组', '可使用的權限群組')}
    error={!all && value.length === 0 ? w('Choose at least one group.', '请至少选择一个权限组。', '請至少選擇一個權限群組。') : undefined}
    hint={all ? w('Every account can use this skill.', '所有账户都可以使用这个技能。', '所有帳戶都可以使用這個技能。') : w('Only accounts in these groups can use this skill.', '只有这些权限组的账户可以使用这个技能。', '只有這些權限群組的帳戶可以使用這個技能。')}>
    <SegmentedControl options={[everyone, chosen]} value={all ? everyone : chosen} className="w-full touch:h-11"
      onChange={(label) => { if (!disabled) onChange(label === everyone ? [ALL] : []); }} />
    {!all && <MultiSelect values={value} disabled={disabled} placeholder={w('Choose permission groups', '选择权限组', '選擇權限群組')}
      aria-label={w('Permission groups', '权限组', '權限群組')}
      options={options.map((group) => ({ value: group, label: admin.group(group) }))} onChange={onChange} />}
  </Field>;
}

/** One organization skill: its assignment and switch (saved together), update from its link, delete. */
function OrgSkillSheet({ skill, groups, onClose, onChanged, onDeleted }: {
  skill: OrgSkill;
  groups: string[];
  onClose: () => void;
  onChanged: (text: string) => void;
  onDeleted: (text: string) => void;
}) {
  const w = useWords();
  const labels = useSkillLabels();
  const formId = useId();
  const [assigned, setAssigned] = useState<string[]>(skill.groups);
  const [enabled, setEnabled] = useState(skill.enabled);
  const [busy, setBusy] = useState<'save' | 'update' | 'delete' | null>(null);
  const [error, setError] = useState<{ kind: 'save' | 'update' | 'delete'; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const dirty = enabled !== skill.enabled || JSON.stringify([...assigned].sort()) !== JSON.stringify([...skill.groups].sort());
  const path = `/api/admin/skills/${encodeURIComponent(skill.name)}`;

  async function run(kind: 'save' | 'update' | 'delete', call: () => Promise<unknown>, done: () => void) {
    setBusy(kind); setError(null);
    try {
      await call();
      done();
    } catch (cause) {
      setError({ kind, text: kind === 'update' ? labels.updateFailure(skill.name, cause) : errorText(cause) });
    } finally {
      setBusy(null);
    }
  }
  const save = () => run('save', () => request(path, { method: 'PATCH', body: JSON.stringify({ enabled, groups: assigned }) }),
    () => onChanged(w(`${skill.name} saved. Changes apply from the next message.`, `${skill.name} 已保存，从下一条消息起生效。`, `${skill.name} 已儲存，從下一則訊息起生效。`)));
  const update = () => run('update', () => request(`${path}/update`, { method: 'POST', body: '{}' }),
    () => onChanged(w(`${skill.name} is up to date.`, `${skill.name} 已更新。`, `${skill.name} 已更新。`)));
  const remove = () => run('delete', () => request(path, { method: 'DELETE' }),
    () => { setConfirming(false); onDeleted(w(`${skill.name} was deleted.`, `已删除 ${skill.name}。`, `已刪除 ${skill.name}。`)); });

  return <>
    <SkillSheet skill={skill} onClose={onClose} footer={<>
      <Button size="sm" className={`mr-auto touch:h-11 touch:px-4 ${DANGER_BUTTON}`} disabled={busy !== null} onClick={() => { setError(null); setConfirming(true); }}>{w('Delete skill', '删除技能', '刪除技能')}</Button>
      {skill.source?.kind === 'url' && <Button size="sm" variant="secondary" className="touch:h-11 touch:px-4" disabled={busy !== null} aria-busy={busy === 'update' || undefined} onClick={() => void update()}>
        {busy === 'update' ? w('Updating…', '正在更新…', '正在更新…') : w('Update from link', '从链接更新', '從連結更新')}
      </Button>}
      <Button size="sm" variant="primary" type="submit" form={formId} className="touch:h-11 touch:px-4" disabled={busy !== null || !dirty || assigned.length === 0} aria-busy={busy === 'save' || undefined}>
        {busy === 'save' ? w('Saving…', '正在保存…', '正在儲存…') : w('Save', '保存', '儲存')}
      </Button>
    </>}>
      <form id={formId} noValidate className="flex flex-col gap-4 rounded-card bg-surface p-4 shadow-card" onSubmit={(event) => { event.preventDefault(); if (dirty && assigned.length) void save(); }}>
        {error && error.kind !== 'delete' && <Notice tone="danger" title={error.kind === 'update' ? w('The skill was not updated', '技能未更新', '技能未更新') : w('The change was not saved', '更改未保存', '變更未儲存')}>{error.text}</Notice>}
        <GroupAssignment value={assigned} onChange={setAssigned} groups={groups} disabled={busy !== null} />
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12.5px] font-medium text-ink">{w('Enabled', '启用', '啟用')}</div>
            <p className="text-[12px] leading-[1.4] text-ink-2">{w('When off, no one can use this skill; its files are kept.', '停用后任何人都不能使用这个技能，文件会保留。', '停用後任何人都不能使用這個技能，檔案會保留。')}</p>
          </div>
          <Switch checked={enabled} disabled={busy !== null} onChange={setEnabled} label={w(`Enable ${skill.name}`, `启用 ${skill.name}`, `啟用 ${skill.name}`)} />
        </div>
      </form>
    </SkillSheet>
    <ConfirmDialog
      open={confirming}
      tone="danger"
      title={w(`Delete ${skill.name}?`, `删除 ${skill.name}？`, `刪除 ${skill.name}？`)}
      description={w('No permission group can use it any more, and its files are removed from the server. This cannot be undone.', '所有权限组都将不能再使用它，技能文件会从服务器删除。删除后无法恢复。', '所有權限群組都將不能再使用它，技能檔案會從伺服器刪除。刪除後無法復原。')}
      confirmLabel={w('Delete skill', '删除技能', '刪除技能')}
      busy={busy === 'delete'}
      error={error?.kind === 'delete' ? error.text : undefined}
      onConfirm={() => void remove()}
      onCancel={() => setConfirming(false)}
    />
  </>;
}
