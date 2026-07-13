import type { CSSProperties } from "react";
import { useI18n } from "../../i18n";
import { cx } from "../../lib/cx";

export interface SkeletonProps {
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  className?: string;
  label?: string;
}
export function Skeleton({ width = "100%", height = 14, className, label }: SkeletonProps) {
  const { t } = useI18n();
  return (
    <span
      className={cx("skeleton", className)}
      style={{ width, height }}
      role="status"
      aria-label={label ?? t("common.loading")}
    />
  );
}
