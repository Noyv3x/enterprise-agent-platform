import { useEffect, useId, useState } from 'react';
import { request, type User } from '../../api';
import { Button } from '../../components/ui/beautiful/atoms/Button';
import { Field, MultiSelect, Notice, Select } from '../../components/ui/beautiful/controls';
import LoadingState from '../../components/ui/beautiful/primitives/LoadingState';
import { useWords } from '../../words';
import { EDITOR_HEADING } from './UserEditor';
import { errorText, useResource, type ChatModelPolicy, type ModelOption } from './shared';

/** Per-user standard chat policy: which models the account may pick per conversation, and the one new conversations start with. */
export function ChatPolicySection({ user, models }: { user: User; models: ModelOption[] }) {
  const w = useWords();
  const titleId = useId();
  const path = `/api/admin/users/${user.id}/chat-model-policy`;
  const policy = useResource<ChatModelPolicy>(path);
  const [draft, setDraft] = useState<ChatModelPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (policy.data) setDraft(policy.data); }, [policy.data]);

  // Saved ids missing from the live catalog stay visible so saving never drops them silently.
  const options = models.map((model) => ({ value: model.id, label: model.name || model.id }));
  for (const id of draft?.allowed_models ?? []) {
    if (!models.some((model) => model.id === id)) options.push({ value: id, label: `${id} · ${w('unavailable', '不可用', '無法使用')}` });
  }
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(policy.data);

  function allow(allowed: string[]) {
    const ordered = options.map((option) => option.value).filter((id) => allowed.includes(id));
    setDraft((old) => ({ allowed_models: ordered, default_model_id: old && ordered.includes(old.default_model_id) ? old.default_model_id : ordered[0] ?? '' }));
    setSaved(false);
  }
  async function save() {
    if (!draft || !dirty || saving) return;
    setSaving(true); setError('');
    try {
      policy.setData(await request<ChatModelPolicy>(path, { method: 'PUT', body: JSON.stringify(draft) }));
      setSaved(true);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  }

  return <section aria-labelledby={titleId} className="flex flex-col gap-3">
    <div>
      <h3 id={titleId} className={EDITOR_HEADING}>{w('Chat models', '聊天模型', '聊天模型')}</h3>
      <p className="mt-0.5 text-[12px] leading-[1.45] text-ink-2">{w('Standard chat lets this account pick among the allowed models in each conversation.', '标准聊天允许该账户在每个对话中从允许的模型里选择。', '標準聊天允許該帳戶在每個對話中從允許的模型裡選擇。')}</p>
    </div>
    {policy.state === 'loading' && <LoadingState label={w('Loading chat models…', '正在加载聊天模型…', '正在載入聊天模型…')} />}
    {policy.state === 'error' && <Notice tone="danger" title={w('Chat models could not be loaded', '无法加载聊天模型', '無法載入聊天模型')}
      action={<Button size="sm" onClick={() => void policy.reload()}>{w('Retry', '重试', '重試')}</Button>}>{policy.error}</Notice>}
    {draft && <form noValidate className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {error && <Notice tone="danger" title={w('Chat models were not saved', '聊天模型未保存', '聊天模型未儲存')}>{error}</Notice>}
      <Field label={w('Allowed models', '允许的模型', '允許的模型')}>
        {options.length
          ? <MultiSelect values={draft.allowed_models} onChange={allow} options={options} disabled={saving} placeholder={w('No models allowed', '未允许任何模型', '未允許任何模型')} />
          : <Notice tone="warning" title={w('No models available', '没有可用模型', '沒有可用模型')}>{w('Connect a Codex account under Models first.', '请先在“模型”中连接 Codex 账户。', '請先在「模型」中連線 Codex 帳戶。')}</Notice>}
      </Field>
      {!draft.allowed_models.length && options.length > 0 && <Notice tone="info" title={w('Standard chat is unavailable to this account until at least one model is allowed.', '至少允许一个模型后，该账户才能使用标准聊天。', '至少允許一個模型後，該帳戶才能使用標準聊天。')} />}
      <Field label={w('New chats start with', '新聊天默认使用', '新聊天預設使用')}>
        <Select value={draft.default_model_id} disabled={!draft.allowed_models.length || saving}
          placeholder={w('Allow a model first', '请先允许一个模型', '請先允許一個模型')}
          onChange={(value: string) => { setDraft({ ...draft, default_model_id: value }); setSaved(false); }}
          options={options.filter((option) => draft.allowed_models.includes(option.value))} />
      </Field>
      <div className="flex items-center justify-end gap-2">
        {saved && !dirty && <span className="mr-auto text-[12px] font-medium text-green-ink">{w('Saved', '已保存', '已儲存')}</span>}
        {dirty && <Button size="sm" type="button" disabled={saving} onClick={() => { setDraft(policy.data); setSaved(false); }}>{w('Discard', '放弃', '放棄')}</Button>}
        <Button size="sm" variant="primary" type="submit" disabled={!dirty || saving}>{saving ? w('Saving…', '正在保存…', '正在儲存…') : w('Save chat models', '保存聊天模型', '儲存聊天模型')}</Button>
      </div>
    </form>}
  </section>;
}
