import { Button, Tooltip } from "antd";
import type { ButtonProps } from "antd";
import type { ReactNode } from "react";
import { useMediaQuery } from "../../hooks/useMediaQuery";

export const COMPACT_HEADER_QUERY = "(max-width: 800px)";

/**
 * Quiet page-header action: icon plus visible label on wide screens, icon-only
 * with a tooltip on narrow ones. The tooltip wrapper stays mounted in both
 * layouts so a resize never remounts the button or drops its focus.
 */
export function HeaderAction({ icon, label, ...props }: { icon: ReactNode; label: string } & Omit<ButtonProps, "icon" | "children" | "type">) {
  const compact = useMediaQuery(COMPACT_HEADER_QUERY);
  return <Tooltip title={compact ? label : undefined}>
    <Button type="text" className="wf-header-action" icon={icon} {...props}>{compact ? null : label}</Button>
  </Tooltip>;
}
