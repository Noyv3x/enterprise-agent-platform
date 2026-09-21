import { Select } from "../../ui/beautiful";
import type { PermissionGroup } from "../../../types";
import { permissionGroupLabel } from "../../../i18n/labels";
import { useI18n } from "../../../i18n";

export function PermissionGroupSelect({ id, groups, value, onChange }: { id?: string; groups: PermissionGroup[]; value: string; onChange: (value: string) => void }) {
  const { t } = useI18n();
  return <Select id={id} value={value} onChange={(next) => onChange(String(next))} options={groups.map((group) => ({ value: group.id, label: permissionGroupLabel(t, group.id, group.label) }))} />;
}
