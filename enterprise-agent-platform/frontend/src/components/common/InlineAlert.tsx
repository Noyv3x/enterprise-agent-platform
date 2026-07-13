import type { ReactNode } from "react";
import { cx } from "../../lib/cx";
import { Icon } from "./Icon";

export interface InlineAlertProps {
  variant?: "info" | "success" | "warning" | "error";
  title?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}
export function InlineAlert({
  variant = "info",
  title,
  children,
  action,
  className,
}: InlineAlertProps) {
  return (
    <div
      className={cx("inline-alert", `inline-alert--${variant}`, className)}
      role={variant === "error" ? "alert" : "status"}
    >
      <Icon name={variant === "success" ? "checkCircle" : "alert"} cls="inline-alert__icon" />
      <div className="inline-alert__body">
        {title ? <strong>{title}</strong> : null}
        <div>{children}</div>
      </div>
      {action ? <div className="inline-alert__action">{action}</div> : null}
    </div>
  );
}
