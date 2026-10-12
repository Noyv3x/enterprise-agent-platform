import { SegmentedControl } from '../../components/ui/beautiful/atoms/SegmentedControl';
import { Field, MultiSelect } from '../../components/ui/beautiful/controls';
import { useWords } from '../../words';
import { useAdminLabels } from './shared';

export const ALL_GROUPS = '*';

/** Everyone (`["*"]`) or chosen permission groups, for an organization skill or connector. `hints` describe the
 * two choices for the thing being assigned. */
export function GroupAssignment({ value, onChange, groups, hints, disabled = false }: {
  value: string[];
  onChange: (value: string[]) => void;
  groups: string[];
  hints: { everyone: string; chosen: string };
  disabled?: boolean;
}) {
  const w = useWords();
  const admin = useAdminLabels();
  const everyone = w('Everyone', '所有人', '所有人');
  const chosen = w('Chosen groups', '指定权限组', '指定權限群組');
  const all = value.includes(ALL_GROUPS);
  // Groups that no longer exist stay visible so the administrator can remove them.
  const options = Array.from(new Set([...groups, ...value.filter((group) => group !== ALL_GROUPS)]));
  return <Field group label={w('Available to', '可使用的权限组', '可使用的權限群組')}
    error={!all && value.length === 0 ? w('Choose at least one group.', '请至少选择一个权限组。', '請至少選擇一個權限群組。') : undefined}
    hint={all ? hints.everyone : hints.chosen}>
    <SegmentedControl options={[everyone, chosen]} value={all ? everyone : chosen} className="w-full touch:h-11"
      onChange={(label) => { if (!disabled) onChange(label === everyone ? [ALL_GROUPS] : []); }} />
    {!all && <MultiSelect values={value} disabled={disabled} placeholder={w('Choose permission groups', '选择权限组', '選擇權限群組')}
      aria-label={w('Permission groups', '权限组', '權限群組')}
      options={options.map((group) => ({ value: group, label: admin.group(group) }))} onChange={onChange} />}
  </Field>;
}
