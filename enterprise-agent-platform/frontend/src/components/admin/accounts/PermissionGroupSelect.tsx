/* <PermissionGroupSelect/> — controlled permission-group dropdown (legacy
   permissionGroupSelect, legacy-app.js:1545-1550). Value is driven by props, not
   set on the DOM after build. */

import type { PermissionGroup } from "../../../types";

export interface PermissionGroupSelectProps {
  groups: PermissionGroup[];
  value: string;
  onChange: (value: string) => void;
}

export function PermissionGroupSelect({ groups, value, onChange }: PermissionGroupSelectProps) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {groups.map((group) => (
        <option key={group.id} value={group.id}>
          {group.label || group.id}
        </option>
      ))}
    </select>
  );
}
