import { Select } from "antd";
import type { PermissionGroup } from "../../../types";
import { permissionGroupLabel } from "../../../i18n/labels";
import { useI18n } from "../../../i18n";

export function PermissionGroupSelect({ id, groups, value, onChange }: { id?: string; groups: PermissionGroup[]; value: string; onChange: (value: string) => void }) {
  const { t } = useI18n();
  return <Select id={id} style={{ width: "100%" }} value={value} onChange={onChange} options={groups.map((group) => ({ value: group.id, label: permissionGroupLabel(t, group.id, group.label) }))} />;
}
