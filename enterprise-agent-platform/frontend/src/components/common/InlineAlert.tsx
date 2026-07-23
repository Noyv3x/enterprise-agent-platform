import { Alert } from "antd";
import type { ReactNode } from "react";

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
    <Alert
      className={className}
      type={variant}
      title={title ?? children}
      description={title ? children : undefined}
      action={action}
      showIcon
    />
  );
}
