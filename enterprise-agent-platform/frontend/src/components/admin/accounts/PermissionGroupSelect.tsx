/* <PermissionGroupSelect/> — controlled permission-group dropdown (legacy
   permissionGroupSelect, legacy-app.js:1545-1550). Value is driven by props, not
   set on the DOM after build. */

import type { PermissionGroup } from "../../../types";
import { useI18n } from "../../../i18n";
import { permissionGroupLabel } from "../../../i18n/labels";

export { permissionGroupLabel } from "../../../i18n/labels";

export interface PermissionGroupSelectProps {
  groups: PermissionGroup[];
  value: string;
  onChange: (value: string) => void;
}

export function PermissionGroupSelect({ groups, value, onChange }: PermissionGroupSelectProps) {
  const { t } = useI18n();
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {groups.map((group) => (
        <option key={group.id} value={group.id}>
          {permissionGroupLabel(t, group.id, group.label)}
        </option>
      ))}
    </select>
  );
}
