import { useId, useMemo, useState } from 'react';
import { request } from '../../api';
import { Button } from '../../components/ui/beautiful/atoms/Button';
import { SegmentedControl } from '../../components/ui/beautiful/atoms/SegmentedControl';
import { Field, FormGrid, Notice, Select, Sheet, TextArea, TextField } from '../../components/ui/beautiful/controls';
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

/** Create/edit sheet. Mount it only while open so each opening starts from the schedule's saved values. */
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
  const [amount, setAmount] = useState(String(initialInterval.amount));
  const [unit, setUnit] = useState<IntervalUnit>(initialInterval.unit);
  const [expression, setExpression] = useState(spec?.type === 'cron' ? spec.expression : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const zones = useMemo(() => timezoneOptions(timezone), [timezone]);

  const everySeconds = /^\d+$/.test(amount.trim()) ? Number(amount) * INTERVAL_UNITS[unit] : 0;
  const atIso = kind === 'once' ? zonedInputToIso(at, timezone) : '';
  const nextSpec: ScheduleSpec | null =
    kind === 'once' ? (atIso ? { type: 'once', at: atIso } : null)
      : kind === 'interval' ? (everySeconds >= MIN_INTERVAL_SECONDS ? { type: 'interval', every_seconds: everySeconds } : null)
        : expression.trim() ? { type: 'cron', expression: expression.trim() } : null;
  const ready = Boolean(name.trim() && prompt.trim() && timezone && nextSpec);

  const submit = async () => {
    if (!nextSpec || !ready || saving) return;
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

  const kinds: Record<Kind, string> = {
    once: w('Once', '一次', '一次'),
    interval: w('Repeating', '重复', '重複'),
    cron: 'Cron',
  };
  const kindByLabel = Object.fromEntries(Object.entries(kinds).map(([key, label]) => [label, key])) as Record<string, Kind>;
  const units: { value: IntervalUnit; label: string }[] = [
    { value: 'minutes', label: w('minutes', '分钟', '分鐘') },
    { value: 'hours', label: w('hours', '小时', '小時') },
    { value: 'days', label: w('days', '天', '天') },
  ];
  const tooShort = kind === 'interval' && amount.trim() !== '' && everySeconds < MIN_INTERVAL_SECONDS;
  const formId = `${id}-form`;

  return <Sheet open onClose={onClose}
    title={schedule ? w('Edit schedule', '编辑定时任务', '編輯排程任務') : w('New schedule', '新建定时任务', '新增排程任務')}
    description={w('Each run sends the instructions to your personal AI.', '每次运行都会把指令发送给你的个人 AI。', '每次執行都會把指令傳送給你的個人 AI。')}
    footer={<>
      <Button size="sm" onClick={onClose} disabled={saving}>{w('Cancel', '取消', '取消')}</Button>
      <Button size="sm" variant="primary" type="submit" form={formId} disabled={!ready || saving}>
        {saving ? w('Saving…', '正在保存…', '正在儲存…') : schedule ? w('Save changes', '保存修改', '儲存變更') : w('Create schedule', '创建定时任务', '建立排程任務')}
      </Button>
    </>}>
    <form id={formId} noValidate className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {error && <Notice tone="danger" title={w('The schedule was not saved', '定时任务未保存', '排程任務未儲存')}>{error}</Notice>}
      <fieldset disabled={saving} className="flex min-w-0 flex-col gap-4">
        <Field label={w('Name', '名称', '名稱')} required>
          <TextField value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label={w('Instructions', '指令', '指令')} required hint={w('Write what the AI should do each time, as you would in a chat message.', '像发送聊天消息一样写下 AI 每次要做的事。', '像傳送聊天訊息一樣寫下 AI 每次要做的事。')}>
          <TextArea value={prompt} rows={4} maxRows={14} maxLength={20_000} onChange={(event) => setPrompt(event.target.value)} />
        </Field>
        <Field group label={w('Runs', '运行方式', '執行方式')}>
          <SegmentedControl className="w-full touch:h-12" options={Object.values(kinds)} value={kinds[kind]} onChange={(label) => setKind(kindByLabel[label])} />
        </Field>
        {kind === 'once' && <Field label={w('Date and time', '日期和时间', '日期與時間')} hint={w(`In ${timezone}. Must be in the future.`, `按 ${timezone} 时间，须晚于当前时间。`, `依 ${timezone} 時間，須晚於目前時間。`)}>
          <TextField type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} />
        </Field>}
        {kind === 'interval' && <FormGrid>
          <Field label={w('Every', '每隔', '每隔')}
            hint={tooShort ? undefined : w('At least 5 minutes. The first run is one interval from now.', '至少 5 分钟。首次运行在一个间隔之后。', '至少 5 分鐘。首次執行在一個間隔之後。')}
            error={tooShort ? w('At least 5 minutes.', '至少 5 分钟。', '至少 5 分鐘。') : undefined}>
            <TextField inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d]/g, ''))} />
          </Field>
          <Field label={w('Unit', '单位', '單位')}>
            <Select<IntervalUnit> value={unit} options={units} onChange={setUnit} />
          </Field>
        </FormGrid>}
        {kind === 'cron' && <Field label={w('Cron expression', 'Cron 表达式', 'Cron 表達式')}
          hint={w('Five fields: minute hour day month weekday. Example: 0 9 * * 1-5 runs at 09:00 on weekdays.', '五个字段：分 时 日 月 星期。例如 0 9 * * 1-5 表示工作日 09:00 运行。', '五個欄位：分 時 日 月 星期。例如 0 9 * * 1-5 表示工作日 09:00 執行。')}>
          <TextField inputClassName="font-mono" value={expression} placeholder="0 9 * * 1-5" spellCheck={false} onChange={(event) => setExpression(event.target.value)} />
        </Field>}
        <Field label={w('Time zone', '时区', '時區')}>
          <Select value={timezone} options={zones} searchable searchPlaceholder={w('Search time zones', '搜索时区', '搜尋時區')} onChange={setTimezone} />
        </Field>
      </fieldset>
    </form>
  </Sheet>;
}
