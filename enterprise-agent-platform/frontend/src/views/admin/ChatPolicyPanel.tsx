import { useEffect, useId, useState } from 'react';
import { Button, Checkbox, Form, Select } from 'antd';
import { request, type User } from '../../api';
import { useWords } from '../../words';
import { DataRegion, FormFooter, Notice, OverlayPanel, Section } from '../../components/ui/fieldwork';
import { errorText, useResource, type ChatModelPolicy, type ModelOption } from './shared';

/** Per-user standard chat policy: which models the account may pick per conversation, and the one new conversations start with. */
export function ChatPolicyPanel({ user, models, onClose }: { user: User; models: ModelOption[]; onClose: () => void }) {
  const w = useWords();
  const formId = useId();
  const path = `/api/admin/users/${user.id}/chat-model-policy`;
  const policy = useResource<ChatModelPolicy>(path);
  const [draft, setDraft] = useState<ChatModelPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
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
  }
  async function save() {
    if (!draft || !dirty || saving) return;
    setSaving(true); setError('');
    try {
      await request<ChatModelPolicy>(path, { method: 'PUT', body: JSON.stringify(draft) });
      onClose();
    } catch (cause) {
      setError(errorText(cause));
      setSaving(false);
    }
  }

  const name = user.display_name || user.username;
  return <OverlayPanel open onClose={onClose} closeLabel={w('Close', '关闭', '關閉')}
    title={w(`Chat models for ${name}`, `${name} 的聊天模型`, `${name} 的聊天模型`)}
    description={w('Standard chat lets this account pick among the allowed models in each conversation.', '标准聊天允许该账户在每个对话中从允许的模型里选择。', '標準聊天允許該帳戶在每個對話中從允許的模型裡選擇。')}
    footer={<FormFooter>
      <Button onClick={onClose} disabled={saving}>{w('Cancel', '取消', '取消')}</Button>
      <Button type="primary" htmlType="submit" form={formId} loading={saving} disabled={!dirty}>{w('Save chat models', '保存聊天模型', '儲存聊天模型')}</Button>
    </FormFooter>}>
    <DataRegion state={policy.state} loadingLabel={w('Loading chat models…', '正在加载聊天模型…', '正在載入聊天模型…')} error={policy.error}
      retry={<Button onClick={() => void policy.reload()}>{w('Retry', '重试', '重試')}</Button>}>
      {draft && <Form id={formId} layout="vertical" onFinish={() => void save()} disabled={saving}>
        {error && <Notice tone="danger" title={error} />}
        <Section title={w('Allowed models', '允许的模型', '允許的模型')}>
          {options.length
            ? <Checkbox.Group aria-label={w('Allowed models', '允许的模型', '允許的模型')} value={draft.allowed_models} onChange={(values) => allow(values as string[])}
                options={options} className="grid gap-2" />
            : <Notice tone="warning" title={w('No models available', '没有可用模型', '沒有可用模型')}>{w('Connect a Codex account under Models & authorization first.', '请先在“模型与授权”中连接 Codex 账户。', '請先在「模型與授權」中連線 Codex 帳戶。')}</Notice>}
          {!draft.allowed_models.length && options.length > 0 && <Notice tone="info" title={w('Standard chat is unavailable to this account until at least one model is allowed.', '至少允许一个模型后，该账户才能使用标准聊天。', '至少允許一個模型後，該帳戶才能使用標準聊天。')} />}
        </Section>
        <Section title={w('Default model', '默认模型', '預設模型')}>
          <Form.Item label={w('New conversations start with', '新对话默认使用', '新對話預設使用')} htmlFor={`${formId}-default`}>
            <Select id={`${formId}-default`} value={draft.default_model_id || undefined} disabled={!draft.allowed_models.length}
              onChange={(value: string) => setDraft({ ...draft, default_model_id: value })}
              options={options.filter((option) => draft.allowed_models.includes(option.value))} />
          </Form.Item>
        </Section>
      </Form>}
    </DataRegion>
  </OverlayPanel>;
}
