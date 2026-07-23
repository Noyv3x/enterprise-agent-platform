import { Skeleton as AntSkeleton } from "antd";
import type { CSSProperties } from "react";
import { useI18n } from "../../i18n";

export interface SkeletonProps {
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  className?: string;
  label?: string;
}

export function Skeleton({ width = "100%", height = 14, className, label }: SkeletonProps) {
  const { t } = useI18n();
  return (
    <AntSkeleton.Input
      active
      block
      className={className}
      style={{ width, height, minWidth: 0 }}
      aria-label={label ?? t("common.loading")}
    />
  );
}
