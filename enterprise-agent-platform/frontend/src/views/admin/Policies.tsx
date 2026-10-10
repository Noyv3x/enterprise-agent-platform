import { useId, useState } from 'react';
import { request } from '../../api';
import { Button } from '../../components/ui/beautiful/atoms/Button';
import { ValuePill } from '../../components/ui/beautiful/atoms/ValuePill';
import { ConfirmDialog, EmptyState, Field, Icon, Notice, Select, Sheet, TextField, type SelectOption } from '../../components/ui/beautiful/controls';
import LoadingState from '../../components/ui/beautiful/primitives/LoadingState';
import RecordsTable, { RecordsSearch, RecordsToolbar, type RecordColumn } from '../../components/ui/beautiful/primitives/RecordsTable';
import { useWords } from '../../words';
import { EditorGroup } from './UserEditor';
import {
  POLICY_SLOTS, THINKING_DEPTHS, errorText, useAdminLabels, useRecordsLabels, useResource,
  type ModelCatalog, type ModelOption, type ModelPolicies, type ModelPolicy, type PolicySlot, type SlotSetting,
} from './shared';

const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const SYSTEM_DEFAULT = '__system_default__';

/** The live catalog, or null while it is loading or could not be fetched: then configured ids cannot be judged. */
type Catalog = ModelOption[] | null;

/** How a configured slot model reads: the system default, a catalog name, or an id the catalog no longer offers. */
function useModelText() {
  const w = useWords();
  return (model: string, catalog: Catalog): { text: string; tone: 'default' | 'model' | 'unavailable' } => {
    if (!model) return { text: w('System default', '系统默认', '系統預設'), tone: 'default' };
    if (!catalog) return { text: model, tone: 'model' };
    const found = catalog.find((item) => item.id === model);
    return found ? { text: found.name || found.id, tone: 'model' } : { text: `${model} · ${w('unavailable', '不可用', '無法使用')}`, tone: 'unavailable' };
  };
}

export function Policies() {
  const w = useWords();
  const labels = useAdminLabels();
  const modelText = useModelText();
  const policies = useResource<ModelPolicies>('/api/admin/model-policies');
  const catalog = useResource<ModelCatalog>('/api/admin/models');
  const [editing, setEditing] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const recordsLabels = useRecordsLabels(w('Model policy groups', '策略组', '策略群組'));
  const list = policies.data?.policies ?? [];
  const members = (name: string) => policies.data?.members[name] ?? 0;
  const models: Catalog = catalog.data ? catalog.data.models : null;

  const needle = query.trim().toLowerCase();
  const rows = list.filter((policy) => !needle || policy.name.toLowerCase().includes(needle) || policy.label.toLowerCase().includes(needle));

  // Member counts lead: they decide what can be deleted, and the five slot columns may scroll off narrower windows.
  const columns: RecordColumn<ModelPolicy>[] = [
    { key: 'members', label: w('Accounts', '账户数', '帳戶數'), glyph: 'user', width: 120,
      sort: (a, b) => members(a.name) - members(b.name),
      render: (policy) => <span className="tabular-nums">{members(policy.name)}</span> },
    ...POLICY_SLOTS.map((slot): RecordColumn<ModelPolicy> => ({
      key: slot, label: labels.slot(slot), glyph: 'model', width: 190,
      sort: (a, b) => a.slots[slot].model.localeCompare(b.slots[slot].model),
      render: (policy) => {
        const setting = policy.slots[slot];
        const model = modelText(setting.model, models);
        return <span className="flex min-w-0 items-center gap-1">
          <span className={`truncate ${model.tone === 'default' ? 'text-ink-2' : model.tone === 'unavailable' ? 'text-orange-ink' : ''}`}>{model.text}</span>
          <ValuePill className="shrink-0" tone={setting.thinking === 'off' ? 'neutral' : 'accent'}>{labels.depth(setting.thinking)}</ValuePill>
        </span>;
      },
    })),
    { key: 'key', label: w('Identifier', '标识', '識別碼'), glyph: 'json', width: 160,
      sort: (a, b) => a.name.localeCompare(b.name),
      render: (policy) => <span className="font-mono text-[12px] text-ink-2">{policy.name}</span> },
  ];

  if (policies.state !== 'ready') {
    return <div className="p-4 sm:p-6">
      {policies.state === 'loading'
        ? <LoadingState label={w('Loading model policy groups…', '正在加载策略组…', '正在載入策略群組…')} />
        : <Notice tone="danger" title={w('Model policy groups could not be loaded', '无法加载策略组', '無法載入策略群組')} action={<Button size="sm" onClick={() => void policies.reload()}>{w('Retry', '重试', '重試')}</Button>}>{policies.error}</Notice>}
    </div>;
  }

  return <div className="flex min-h-0 flex-1 flex-col">
    {catalog.error && <div className="px-4 pt-3 sm:px-6"><Notice tone="warning" title={w('Model catalog unavailable', '模型目录不可用', '模型目錄無法使用')}>{catalog.error}</Notice></div>}
    <RecordsTable<ModelPolicy>
      fill
      rows={rows}
      rowId={(policy) => policy.name}
      primary={{ label: w('Group', '策略组', '策略群組'), glyph: 'text', width: 200, name: (policy) => policy.label }}
      columns={columns}
      labels={recordsLabels}
      selectedId={editing === '' ? null : editing}
      onOpen={(policy) => setEditing(policy.name)}
      empty={list.length
        ? w('No groups match the search.', '没有符合搜索的策略组。', '沒有符合搜尋的策略群組。')
        : <EmptyState title={w('No model policy groups', '暂无策略组', '尚無策略群組')} description={w('Create a group, then assign accounts to it.', '创建策略组，然后把账户分配到该组。', '建立策略群組，然後將帳戶指派到該群組。')} />}
      toolbar={<RecordsToolbar
        left={<RecordsSearch value={query} onChange={setQuery} label={w('Search groups', '搜索策略组', '搜尋策略群組')} placeholder={w('Search name or identifier', '搜索名称或标识', '搜尋名稱或識別碼')} />}
        right={<>
          <button type="button" className="records-quiet-button" disabled={policies.refreshing} onClick={() => { void policies.reload(); void catalog.reload(); }}>
            <Icon name="refresh" size={14} />{w('Refresh', '刷新', '重新整理')}
          </button>
          <Button size="sm" variant="primary" onClick={() => setEditing('')}>
            <Icon name="plus" size={14} />{w('New group', '新建策略组', '新增策略群組')}
          </Button>
        </>} />}
    />
    {editing !== null && <PolicyEditor
      key={editing}
      policy={list.find((policy) => policy.name === editing) ?? null}
      policies={list}
      members={members}
      catalog={models}
      connected={catalog.data?.connected ?? true}
      onSaved={(next) => { policies.setData(next); }}
      onClose={() => setEditing(null)}
    />}
  </div>;
}

type Slots = Record<PolicySlot, SlotSetting>;

/** Create, edit or delete one group. The API stores the whole list, so every save sends the full list. */
function PolicyEditor({ policy, policies, members, catalog, connected, onSaved, onClose }: {
  policy: ModelPolicy | null;
  policies: ModelPolicy[];
  members: (name: string) => number;
  catalog: Catalog;
  connected: boolean;
  onSaved: (next: ModelPolicies) => void;
  onClose: () => void;
}) {
  const w = useWords();
  const [current, setCurrent] = useState<ModelPolicy | null>(policy);
  const [name, setName] = useState(policy?.name ?? '');
  const [label, setLabel] = useState(policy?.label ?? '');
  // A new group starts on the system default with medium thinking in every slot, like the fresh-install baseline.
  const [slots, setSlots] = useState<Slots>(() => policy?.slots ?? Object.fromEntries(POLICY_SLOTS.map((slot) => [slot, { model: '', thinking: 'medium' }])) as Slots);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const trimmedName = name.trim();
  const trimmedLabel = label.trim();
  const nameTaken = !current && policies.some((item) => item.name === trimmedName);
  const nameInvalid = !current && trimmedName !== '' && !NAME_PATTERN.test(trimmedName);
  const valid = trimmedLabel !== '' && (current !== null || (trimmedName !== '' && !nameTaken && !nameInvalid));
  const dirty = current
    ? trimmedLabel !== current.label || JSON.stringify(slots) !== JSON.stringify(current.slots)
    : trimmedName !== '' || trimmedLabel !== '';
  const count = current ? members(current.name) : 0;
  const last = current !== null && policies.length === 1;
  const formId = `policy-${current?.name ?? 'new'}`;

  function setSlot(slot: PolicySlot, patch: Partial<SlotSetting>) {
    setSlots((old) => ({ ...old, [slot]: { ...old[slot], ...patch } }));
    setSaved(false);
  }

  async function put(next: ModelPolicy[]) {
    setSaving(true); setError('');
    try {
      const response = await request<ModelPolicies>('/api/admin/model-policies', { method: 'PUT', body: JSON.stringify({ policies: next }) });
      onSaved(response);
      return response;
    } catch (cause) {
      setError(errorText(cause));
      return null;
    } finally {
      setSaving(false);
    }
  }
  async function save() {
    if (!dirty || !valid || saving) return;
    const entry: ModelPolicy = { name: current?.name ?? trimmedName, label: trimmedLabel, slots };
    const response = await put(current ? policies.map((item) => item.name === current.name ? entry : item) : [...policies, entry]);
    if (response) {
      const stored = response.policies.find((item) => item.name === entry.name) ?? entry;
      setCurrent(stored);
      setLabel(stored.label);
      setSlots(stored.slots);
      setSaved(true);
    }
  }
  async function remove() {
    if (!current) return;
    const response = await put(policies.filter((item) => item.name !== current.name));
    if (!response) return;
    setConfirming(false);
    onClose();
  }

  const title = current ? current.label : w('New model policy group', '新建策略组', '新增策略群組');
  return <Sheet
    open
    width={520}
    onClose={onClose}
    title={title}
    description={current
      ? w(`Changes apply to every account in this group (${count}) from its next run.`, `修改会从下一次运行起作用于组内所有账户（${count} 个）。`, `修改會從下一次執行起套用到群組內所有帳戶（${count} 個）。`)
      : w('Name the group and choose the model and thinking depth for each use.', '为策略组命名，并为每种用途选择模型和思考深度。', '為策略群組命名，並為每種用途選擇模型和思考深度。')}
    footer={<>
      {saved && !dirty && <span className="mr-auto text-[12px] font-medium text-green-ink">{w('Saved', '已保存', '已儲存')}</span>}
      {dirty && current && <span className="mr-auto text-[12px] text-ink-2">{w('Unsaved changes', '有未保存的更改', '有未儲存的變更')}</span>}
      <Button size="sm" onClick={onClose} disabled={saving}>{dirty ? w('Cancel', '取消', '取消') : w('Done', '完成', '完成')}</Button>
      <Button size="sm" variant="primary" type="submit" form={formId} disabled={saving || !dirty || !valid}>
        {saving ? w('Saving…', '正在保存…', '正在儲存…') : current ? w('Save group', '保存策略组', '儲存策略群組') : w('Create group', '创建策略组', '建立策略群組')}
      </Button>
    </>}
  >
    <form id={formId} noValidate className="flex flex-col gap-5" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {error && !confirming && <Notice tone="danger" title={w('The group was not saved', '策略组未保存', '策略群組未儲存')}>{error}</Notice>}
      {!connected && <Notice tone="warning" title={w('Codex is not connected', 'Codex 未连接', 'Codex 未連線')}>
        {w('No model can run until an administrator connects Codex on the Models tab.', '管理员在“模型”页连接 Codex 之前，没有可运行的模型。', '管理員在「模型」頁連接 Codex 之前，沒有可執行的模型。')}
      </Notice>}
      <fieldset disabled={saving} className="contents">
        <EditorGroup title={w('Group', '策略组', '策略群組')} first>
          <Field label={w('Name', '名称', '名稱')} required hint={w('Shown to administrators only.', '只对管理员显示。', '只對管理員顯示。')}>
            <TextField value={label} maxLength={64} autoComplete="off" onChange={(event) => { setLabel(event.target.value); setSaved(false); }} />
          </Field>
          <Field label={w('Identifier', '标识', '識別碼')} required={!current}
            error={nameTaken ? w('A group with this identifier already exists.', '已存在同标识的策略组。', '已存在同識別碼的策略群組。')
              : nameInvalid ? w('Start with a lowercase letter; then use lowercase letters, digits, “-” or “_”.', '以小写字母开头，其后只用小写字母、数字、“-”或“_”。', '以小寫字母開頭，其後只用小寫字母、數字、「-」或「_」。') : undefined}
            hint={current ? w('Identifiers cannot be changed; accounts refer to them.', '标识不可修改，账户通过它引用策略组。', '識別碼無法修改，帳戶透過它參照策略群組。') : w('For example “light”.', '例如 “light”。', '例如「light」。')}>
            <TextField value={name} readOnly={!!current} maxLength={64} autoComplete="off" spellCheck={false} className="font-mono" onChange={(event) => { setName(event.target.value); setSaved(false); }} />
          </Field>
        </EditorGroup>
        <EditorGroup title={w('Models and thinking', '模型与思考', '模型與思考')}
          description={w('System default is the first model the Codex catalog offers.', '“系统默认”是 Codex 模型目录中的第一个模型。', '「系統預設」是 Codex 模型目錄中的第一個模型。')}>
          <div className="flex flex-col">
            {POLICY_SLOTS.map((slot) => <SlotRow key={slot} slot={slot} setting={slots[slot]} catalog={catalog} onChange={(patch) => setSlot(slot, patch)} />)}
          </div>
        </EditorGroup>
      </fieldset>
    </form>
    {current && <section className="mt-6 flex flex-col gap-2 border-t border-line pt-5" aria-label={w('Delete group', '删除策略组', '刪除策略群組')}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[12px] leading-[1.45] text-ink-2">{count > 0
          ? w(`Move its ${count} accounts to another group before deleting it.`, `删除前请先把组内 ${count} 个账户移到其他策略组。`, `刪除前請先將群組內 ${count} 個帳戶移到其他策略群組。`)
          : last
            ? w('The last group cannot be deleted.', '不能删除最后一个策略组。', '無法刪除最後一個策略群組。')
            : w('Deleting removes the group for everyone.', '删除后所有人都无法再使用该策略组。', '刪除後所有人都無法再使用該策略群組。')}</p>
        <Button size="sm" className="shrink-0 bg-red-tint text-red-ink shadow-none hover:bg-red-tint hover:brightness-95" disabled={saving || count > 0 || last} onClick={() => setConfirming(true)}>
          {w('Delete group', '删除策略组', '刪除策略群組')}
        </Button>
      </div>
    </section>}
    <ConfirmDialog
      open={confirming}
      tone="danger"
      title={w(`Delete ${title}?`, `删除 ${title}？`, `刪除 ${title}？`)}
      description={w('Accounts can no longer be assigned to it.', '账户将不能再被分配到该策略组。', '帳戶將無法再被指派到該策略群組。')}
      confirmLabel={w('Delete group', '删除策略组', '刪除策略群組')}
      busy={saving}
      error={confirming ? error || undefined : undefined}
      onConfirm={() => void remove()}
      onCancel={() => { setConfirming(false); setError(''); }}
    />
  </Sheet>;
}

/** One usage slot: what it covers, then its model and thinking depth side by side. */
function SlotRow({ slot, setting, catalog, onChange }: {
  slot: PolicySlot;
  setting: SlotSetting;
  catalog: Catalog;
  onChange: (patch: Partial<SlotSetting>) => void;
}) {
  const w = useWords();
  const labels = useAdminLabels();
  const modelText = useModelText();
  const id = useId();
  const name = labels.slot(slot);
  const first = catalog?.[0];
  const options: SelectOption[] = [
    { value: SYSTEM_DEFAULT, label: w('System default', '系统默认', '系統預設'),
      description: first ? w(`Currently ${first.name || first.id}`, `当前为 ${first.name || first.id}`, `目前為 ${first.name || first.id}`) : undefined },
    ...(catalog ?? []).map((model) => ({ value: model.id, label: model.name || model.id })),
  ];
  if (setting.model && !catalog?.some((model) => model.id === setting.model)) options.push({ value: setting.model, label: modelText(setting.model, catalog).text });
  return <div role="group" aria-labelledby={id} className="flex flex-col gap-2 border-t border-line py-3 first:border-t-0 first:pt-0 last:pb-0">
    <div className="flex flex-col gap-0.5">
      <h4 id={id} className="text-[12.5px] font-medium text-ink">{name}</h4>
      <p className="text-[12px] leading-[1.4] text-ink-2">{labels.slotHint(slot)}</p>
    </div>
    <div className="flex gap-2">
      <div className="min-w-0 flex-1">
        <Select aria-label={w(`${name} model`, `${name}模型`, `${name}模型`)} value={setting.model || SYSTEM_DEFAULT}
          onChange={(value: string) => onChange({ model: value === SYSTEM_DEFAULT ? '' : value })} options={options} />
      </div>
      <div className="w-32 shrink-0">
        <Select aria-label={w(`${name} thinking depth`, `${name}思考深度`, `${name}思考深度`)} value={setting.thinking}
          onChange={(thinking: string) => onChange({ thinking })}
          options={THINKING_DEPTHS.map((depth) => ({ value: depth, label: labels.depth(depth) }))} />
      </div>
    </div>
  </div>;
}
