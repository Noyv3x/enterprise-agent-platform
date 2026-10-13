import { useState } from 'react';
import { request } from '../../api';
import { Button } from '../../components/ui/beautiful/atoms/Button';
import { ValuePill } from '../../components/ui/beautiful/atoms/ValuePill';
import { ConfirmDialog, EmptyState, Field, FormGrid, Icon, Notice, Select, Sheet, TextField, type SelectOption } from '../../components/ui/beautiful/controls';
import LoadingState from '../../components/ui/beautiful/primitives/LoadingState';
import RecordsTable, { RecordsSearch, RecordsToolbar, type RecordColumn } from '../../components/ui/beautiful/primitives/RecordsTable';
import { useWords } from '../../words';
import { EditorGroup } from './UserEditor';
import {
  AUTO_THINKING_MODEL, MAIN_THINKING_DEPTHS, THINKING_DEPTHS, errorText, useAdminLabels, useRecordsLabels, useResource,
  type ModelCatalog, type ModelOption, type ModelPolicies, type ModelPolicy, type ModelSetting,
} from './shared';

const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
/** Select value for `model: ''`: 系统默认 for the main model, 与主模型相同 for the judge. */
const UNSET = '__unset__';
/** A new group starts like a fresh install: the system default at medium, judged by the same model at low. */
const NEW_MAIN: ModelSetting = { model: '', thinking: 'medium' };
const NEW_JUDGE: ModelSetting = { model: '', thinking: 'low' };

type Role = 'main' | 'judge';

/** The live catalog, or null while it is loading or could not be fetched: then configured ids cannot be judged. */
type Catalog = ModelOption[] | null;
type ModelText = { text: string; tone: 'default' | 'model' | 'unavailable' };
type ModelTextOf = (model: string, catalog: Catalog, role?: Role) => ModelText;

/** How a configured model reads: unset (系统默认 / 与主模型相同), a catalog name, or an id the catalog no longer offers. */
function useModelText(): ModelTextOf {
  const w = useWords();
  return (model: string, catalog: Catalog, role: Role = 'main'): ModelText => {
    if (!model) return { text: role === 'main' ? w('System default', '系统默认', '系統預設') : w('Same as main model', '与主模型相同', '與主模型相同'), tone: 'default' };
    if (!catalog) return { text: model, tone: 'model' };
    const found = catalog.find((item) => item.id === model);
    return found ? { text: found.name || found.id, tone: 'model' } : { text: `${model} · ${w('unavailable', '不可用', '無法使用')}`, tone: 'unavailable' };
  };
}

/** A model and its thinking depth in one table cell. */
function SettingCell({ model, thinking }: { model: ModelText; thinking: string }) {
  const labels = useAdminLabels();
  return <span className="flex min-w-0 items-center gap-1">
    <span className={`truncate ${model.tone === 'default' ? 'text-ink-2' : model.tone === 'unavailable' ? 'text-orange-ink' : ''}`}>{model.text}</span>
    <ValuePill className="shrink-0" tone={thinking === 'auto' ? 'green' : thinking === 'off' ? 'neutral' : 'accent'}>{labels.depth(thinking)}</ValuePill>
  </span>;
}

export function Policies() {
  const w = useWords();
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

  // Member counts lead: they decide what can be deleted.
  const columns: RecordColumn<ModelPolicy>[] = [
    { key: 'members', label: w('Accounts', '账户数', '帳戶數'), glyph: 'user', width: 110,
      sort: (a, b) => members(a.name) - members(b.name),
      render: (policy) => <span className="tabular-nums">{members(policy.name)}</span> },
    { key: 'main', label: w('Main model', '主模型', '主模型'), glyph: 'model', width: 220,
      sort: (a, b) => a.main.model.localeCompare(b.main.model),
      render: (policy) => <SettingCell model={modelText(policy.main.model, models)} thinking={policy.main.thinking} /> },
    { key: 'judge', label: w('Judge model', 'Judge 模型', 'Judge 模型'), glyph: 'model', width: 220,
      sort: (a, b) => a.judge.model.localeCompare(b.judge.model),
      render: (policy) => <SettingCell model={modelText(policy.judge.model, models, 'judge')} thinking={policy.judge.thinking} /> },
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
  const labels = useAdminLabels();
  const modelText = useModelText();
  const [current, setCurrent] = useState<ModelPolicy | null>(policy);
  const [name, setName] = useState(policy?.name ?? '');
  const [label, setLabel] = useState(policy?.label ?? '');
  const [main, setMain] = useState<ModelSetting>(policy?.main ?? NEW_MAIN);
  const [judge, setJudge] = useState<ModelSetting>(policy?.judge ?? NEW_JUDGE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const trimmedName = name.trim();
  const trimmedLabel = label.trim();
  const nameTaken = !current && policies.some((item) => item.name === trimmedName);
  const nameInvalid = !current && trimmedName !== '' && !NAME_PATTERN.test(trimmedName);
  const autoAllowed = AUTO_THINKING_MODEL.test(main.model);
  const autoInvalid = main.thinking === 'auto' && !autoAllowed;
  const valid = trimmedLabel !== '' && !autoInvalid && (current !== null || (trimmedName !== '' && !nameTaken && !nameInvalid));
  const dirty = current
    ? trimmedLabel !== current.label || JSON.stringify(main) !== JSON.stringify(current.main) || JSON.stringify(judge) !== JSON.stringify(current.judge)
    : trimmedName !== '' || trimmedLabel !== '';
  const count = current ? members(current.name) : 0;
  const last = current !== null && policies.length === 1;
  const formId = `policy-${current?.name ?? 'new'}`;

  const first = catalog?.[0];
  const firstName = first ? first.name || first.id : '';
  // What 与主模型相同 resolves to right now: the chosen main model, or the catalog's first model for 系统默认.
  const mainResolved = main.model ? modelText(main.model, catalog).text : firstName;

  function update(role: Role, patch: Partial<ModelSetting>) {
    (role === 'main' ? setMain : setJudge)((old) => ({ ...old, ...patch }));
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
    const entry: ModelPolicy = { name: current?.name ?? trimmedName, label: trimmedLabel, main, judge };
    const response = await put(current ? policies.map((item) => item.name === current.name ? entry : item) : [...policies, entry]);
    if (response) {
      const stored = response.policies.find((item) => item.name === entry.name) ?? entry;
      setCurrent(stored);
      setLabel(stored.label);
      setMain(stored.main);
      setJudge(stored.judge);
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

  const mainDepths: SelectOption[] = MAIN_THINKING_DEPTHS.map((depth) => depth === 'auto'
    ? { value: depth, label: labels.depth(depth), disabled: !autoAllowed,
      description: autoAllowed
        ? w('The judge picks a depth each turn', '每轮由 Judge 判断难度后选择', '每輪由 Judge 判斷難度後選擇')
        : w('Choose a GPT-6 model first', '需先选择 GPT-6 系列模型', '需先選擇 GPT-6 系列模型') }
    : { value: depth, label: labels.depth(depth) });
  const judgeDepths: SelectOption[] = THINKING_DEPTHS.map((depth) => ({ value: depth, label: labels.depth(depth) }));

  const title = current ? current.label : w('New model policy group', '新建策略组', '新增策略群組');
  return <Sheet
    open
    width={520}
    onClose={onClose}
    title={title}
    description={current
      ? w(`Changes apply to every account in this group (${count}) from its next run.`, `修改会从下一次运行起作用于组内所有账户（${count} 个）。`, `修改會從下一次執行起套用到群組內所有帳戶（${count} 個）。`)
      : w('Name the group, then choose its main model and judge model.', '为策略组命名，然后选择主模型和 Judge 模型。', '為策略群組命名，然後選擇主模型和 Judge 模型。')}
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
        <EditorGroup title={w('Main model', '主模型', '主模型')}
          description={w('Used by the personal AI, plain chat, channels and every subagent.', '主模型用于个人 AI、纯聊天模式、频道和全部子智能体。', '主模型用於個人 AI、純聊天模式、頻道和全部子智慧體。')}>
          <FormGrid>
            <Field label={w('Model', '模型', '模型')}>
              <Select aria-label={w('Main model', '主模型', '主模型')} value={main.model || UNSET}
                onChange={(value: string) => update('main', { model: value === UNSET ? '' : value })}
                options={modelOptions(main.model, catalog, {
                  label: w('System default', '系统默认', '系統預設'),
                  description: firstName ? w(`Currently ${firstName}`, `当前为 ${firstName}`, `目前為 ${firstName}`) : undefined,
                }, modelText)} />
            </Field>
            <Field label={w('Thinking depth', '思考深度', '思考深度')}
              error={autoInvalid ? w('Auto needs a GPT-6 main model. Choose one, or pick a fixed depth.', '「自动」需要 GPT-6 系列主模型。请改选模型或固定深度。', '「自動」需要 GPT-6 系列主模型。請改選模型或固定深度。') : undefined}
              hint={main.thinking === 'auto' && autoAllowed ? w('Before each turn the judge rates its difficulty and picks the depth.', '每轮开始前由 Judge 判断难度并选择深度。', '每輪開始前由 Judge 判斷難度並選擇深度。') : undefined}>
              <Select aria-label={w('Main model thinking depth', '主模型思考深度', '主模型思考深度')} value={main.thinking}
                onChange={(thinking: string) => update('main', { thinking })} options={mainDepths} />
            </Field>
          </FormGrid>
        </EditorGroup>
        <EditorGroup title={w('Judge model', 'Judge 模型', 'Judge 模型')}
          description={w('Titles chats, and rates each turn’s difficulty when the main model’s depth is Auto.', 'Judge 用于生成聊天标题，并在主模型为「自动」时判断每轮难度。', 'Judge 用於產生聊天標題，並在主模型為「自動」時判斷每輪難度。')}>
          <FormGrid>
            <Field label={w('Model', '模型', '模型')}>
              <Select aria-label={w('Judge model', 'Judge 模型', 'Judge 模型')} value={judge.model || UNSET}
                onChange={(value: string) => update('judge', { model: value === UNSET ? '' : value })}
                options={modelOptions(judge.model, catalog, {
                  label: w('Same as main model', '与主模型相同', '與主模型相同'),
                  description: mainResolved ? w(`Currently ${mainResolved}`, `当前为 ${mainResolved}`, `目前為 ${mainResolved}`) : undefined,
                }, modelText)} />
            </Field>
            <Field label={w('Thinking depth', '思考深度', '思考深度')}>
              <Select aria-label={w('Judge model thinking depth', 'Judge 模型思考深度', 'Judge 模型思考深度')} value={judge.thinking}
                onChange={(thinking: string) => update('judge', { thinking })} options={judgeDepths} />
            </Field>
          </FormGrid>
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

/** The unset choice first, then the live catalog; a configured id the catalog no longer offers stays listed as unavailable. */
function modelOptions(model: string, catalog: Catalog, unset: { label: string; description?: string }, modelText: ModelTextOf): SelectOption[] {
  const options: SelectOption[] = [
    { value: UNSET, ...unset },
    ...(catalog ?? []).map((item) => ({ value: item.id, label: item.name || item.id })),
  ];
  if (model && !catalog?.some((item) => item.id === model)) options.push({ value: model, label: modelText(model, catalog).text });
  return options;
}
