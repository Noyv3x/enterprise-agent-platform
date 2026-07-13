import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import { Spinner } from "./Spinner";

export interface LoadingButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean;
  loadingLabel?: ReactNode;
  variant?: "default" | "primary" | "danger" | "ghost";
}
export function LoadingButton({
  loading = false,
  loadingLabel,
  variant = "default",
  className,
  disabled,
  children,
  type = "button",
  ...props
}: LoadingButtonProps) {
  return (
    <button
      {...props}
      className={cx("btn", variant !== "default" && `btn--${variant}`, className)}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <Spinner size={17} /> : null}
      <span>{loading && loadingLabel ? loadingLabel : children}</span>
    </button>
  );
}
