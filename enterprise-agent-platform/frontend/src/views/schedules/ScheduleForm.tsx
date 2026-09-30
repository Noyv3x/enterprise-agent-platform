import { Button, Form, Input, InputNumber, Segmented, Select } from 'antd';
import { useId, useMemo, useState } from 'react';
import { request } from '../../api';
import { FormFooter, FormGrid, Notice, OverlayPanel } from '../../components/ui/fieldwork';
import { useWords } from '../../words';
import { browserTimezone, timezoneOptions } from '../settings/timezones';
import { INTERVAL_UNITS, MIN_INTERVAL_SECONDS, isoToZonedInput, splitInterval, zonedInputToIso } from './model';
import type { IntervalUnit, Schedule, ScheduleInput, ScheduleSpec } from './model';

type Kind = ScheduleSpec['type'];

export interface ScheduleFormProps {
  /** The schedule being edited; null creates a new one. */
  schedule: Schedule | null;
  onClose: () => void;
  onSaved: (schedule: Schedule) => void;
}

/** Create/edit drawer. Mount it only while open so each opening starts from the schedule's saved values. */
export function ScheduleForm({ schedule, onClose, onSaved }: ScheduleFormProps) {
  const w = useWords();
  const id = useId();
  const spec = schedule?.schedule;
  const initialTimezone = schedule?.timezone || browserTimezone();
  const initialInterval = splitInterval(spec?.type === 'interval' ? spec.every_seconds : INTERVAL_UNITS.days);
  const [name, setName] = useState(schedule?.name ?? '');
  const [prompt, setPrompt] = useState(schedule?.prompt ?? '');
  const [timezone, setTimezone] = useState(initialTimezone);
  const [kind, setKind] = useState<Kind>(spec?.type ?? 'interval');
  const [at, setAt] = useState(spec?.type === 'once' ? isoToZonedInput(spec.at, initialTimezone) : '');
  const [amount, setAmount] = useState<number>(initialInterval.amount);
  const [unit, setUnit] = useState<IntervalUnit>(initialInterval.unit);
  const [expression, setExpression] = useState(spec?.type === 'cron' ? spec.expression : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const zones = useMemo(() => timezoneOptions(timezone), [timezone]);

  const everySeconds = Math.round((amount || 0) * INTERVAL_UNITS[unit]);
  const atIso = kind === 'once' ? zonedInputToIso(at, timezone) : '';
  const nextSpec: ScheduleSpec | null =
    kind === 'once' ? (atIso ? { type: 'once', at: atIso } : null)
      : kind === 'interval' ? (everySeconds >= MIN_INTERVAL_SECONDS ? { type: 'interval', every_seconds: everySeconds } : null)
        : expression.trim() ? { type: 'cron', expression: expression.trim() } : null;
  const ready = Boolean(name.trim() && prompt.trim() && timezone && nextSpec);

  const submit = async () => {
    if (!nextSpec || saving) return;
    const body: ScheduleInput = { name: name.trim(), prompt: prompt.trim(), schedule: nextSpec, timezone };
    setSaving(true);
    setError('');
    try {
      const result = await request<{ schedule: Schedule }>(schedule ? `/api/schedules/${schedule.id}` : '/api/schedules', {
        method: schedule ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      });
      onSaved(result.schedule);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setSaving(false);
    }
  };

  const kinds: { value: Kind; label: string }[] = [
    { value: 'once', label: w('Once', '一次', '一次') },
    { value: 'interval', label: w('Repeating', '重复', '重複') },
    { value: 'cron', label: w('Cron', 'Cron 表达式', 'Cron 表達式') },
  ];
  const units = [
    { value: 'minutes', label: w('minutes', '分钟', '分鐘') },
    { value: 'hours', label: w('hours', '小时', '小時') },
    { value: 'days', label: w('days', '天', '天') },
  ];
  const title = schedule ? w('Edit schedule', '编辑定时任务', '編輯排程任務') : w('New schedule', '新建定时任务', '新增排程任務');

  return <OverlayPanel open onClose={onClose} title={title}
    description={w('Each run sends the instructions to your personal AI.', '每次运行都会把指令发送给你的个人 AI。', '每次執行都會把指令傳送給你的個人 AI。')}
    closeLabel={w('Close', '关闭', '關閉')}
    footer={<FormFooter>
      <Button onClick={onClose} disabled={saving}>{w('Cancel', '取消', '取消')}</Button>
      <Button type="primary" htmlType="submit" form={`${id}-form`} loading={saving} disabled={!ready}>{schedule ? w('Save changes', '保存修改', '儲存變更') : w('Create schedule', '创建定时任务', '建立排程任務')}</Button>
    </FormFooter>}>
    <Form id={`${id}-form`} layout="vertical" onFinish={() => void submit()} disabled={saving}>
      {error && <Notice tone="danger" title={w('The schedule was not saved', '定时任务未保存', '排程任務未儲存')}>{error}</Notice>}
      <Form.Item label={w('Name', '名称', '名稱')} htmlFor={`${id}-name`}>
        <Input id={`${id}-name`} value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
      </Form.Item>
      <Form.Item label={w('Instructions', '指令', '指令')} htmlFor={`${id}-prompt`}
        extra={w('Write what the AI should do each time, as you would in a chat message.', '像发送聊天消息一样写下 AI 每次要做的事。', '像傳送聊天訊息一樣寫下 AI 每次要做的事。')}>
        <Input.TextArea id={`${id}-prompt`} value={prompt} autoSize={{ minRows: 4, maxRows: 14 }} maxLength={20_000} onChange={(event) => setPrompt(event.target.value)} />
      </Form.Item>
      <Form.Item label={w('Runs', '运行方式', '執行方式')}>
        <Segmented<Kind> block value={kind} options={kinds} onChange={setKind} />
      </Form.Item>
      {kind === 'once' && <Form.Item label={w('Date and time', '日期和时间', '日期與時間')} htmlFor={`${id}-at`}
        extra={w(`In ${timezone}. Must be in the future.`, `按 ${timezone} 时间，须晚于当前时间。`, `依 ${timezone} 時間，須晚於目前時間。`)}>
        <Input id={`${id}-at`} type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} />
      </Form.Item>}
      {kind === 'interval' && <FormGrid>
        <Form.Item label={w('Every', '每隔', '每隔')} htmlFor={`${id}-amount`}
          extra={w('At least 5 minutes. The first run is one interval from now.', '至少 5 分钟。首次运行在一个间隔之后。', '至少 5 分鐘。首次執行在一個間隔之後。')}
          validateStatus={everySeconds < MIN_INTERVAL_SECONDS ? 'error' : undefined}>
          <InputNumber id={`${id}-amount`} className="wf-schedule-amount" min={1} precision={0} value={amount} onChange={(value) => setAmount(value ?? 0)} />
        </Form.Item>
        <Form.Item label={w('Unit', '单位', '單位')} htmlFor={`${id}-unit`}>
          <Select<IntervalUnit> id={`${id}-unit`} value={unit} options={units} onChange={setUnit} />
        </Form.Item>
      </FormGrid>}
      {kind === 'cron' && <Form.Item label={w('Cron expression', 'Cron 表达式', 'Cron 表達式')} htmlFor={`${id}-cron`}
        extra={w('Five fields: minute hour day month weekday. Example: 0 9 * * 1-5 runs at 09:00 on weekdays.', '五个字段：分 时 日 月 星期。例如 0 9 * * 1-5 表示工作日 09:00 运行。', '五個欄位：分 時 日 月 星期。例如 0 9 * * 1-5 表示工作日 09:00 執行。')}>
        <Input id={`${id}-cron`} className="wf-mono" value={expression} placeholder="0 9 * * 1-5" spellCheck={false} onChange={(event) => setExpression(event.target.value)} />
      </Form.Item>}
      <Form.Item label={w('Time zone', '时区', '時區')} htmlFor={`${id}-zone`}>
        <Select id={`${id}-zone`} value={timezone} options={zones} showSearch={{ optionFilterProp: 'label' }} onChange={setTimezone} />
      </Form.Item>
    </Form>
  </OverlayPanel>;
}
