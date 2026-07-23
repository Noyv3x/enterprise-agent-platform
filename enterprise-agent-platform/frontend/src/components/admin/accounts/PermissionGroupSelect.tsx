/* <PermissionGroupSelect/> — controlled permission-group dropdown (legacy
   permissionGroupSelect, legacy-app.js:1545-1550). Value is driven by props, not
   set on the DOM after build. */

import type { PermissionGroup } from "../../../types";
import { useI18n } from "../../../i18n";
import { permissionGroupLabel } from "../../../i18n/labels";
import { Select } from "antd";

export { permissionGroupLabel } from "../../../i18n/labels";

export interface PermissionGroupSelectProps {
  id?: string;
  groups: PermissionGroup[];
  value: string;
  onChange: (value: string) => void;
}

export function PermissionGroupSelect({ id, groups, value, onChange }: PermissionGroupSelectProps) {
  const { t } = useI18n();
  return <Select
    id={id}
    styles={{ input: { minHeight: 0 } }}
    value={value}
    onChange={onChange}
    options={groups.map((group) => ({
      value: group.id,
      label: permissionGroupLabel(t, group.id, group.label),
    }))}
  />;
}
