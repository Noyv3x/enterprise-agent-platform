import type { ReactNode } from "react";
import { Button } from "antd";
import { useResourceState } from "../../hooks/useResourceState";
import { useI18n } from "../../i18n";
import { InlineAlert } from "./InlineAlert";
import { Skeleton } from "./Skeleton";
import { Spinner } from "./Spinner";

export function ResourceStatusView({
  resourceKey,
  hasData,
  onRetry,
  children,
}: {
  resourceKey: string;
  hasData: boolean;
  onRetry: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const resource = useResourceState(resourceKey);
  const initialLoading = !hasData && (resource.status === "idle" || resource.status === "loading");

  if (initialLoading) {
    return (
      <div className="resource-skeleton" role="status" aria-label={t("resource.loading")}>
        <Spinner size={20} />
        <div className="resource-skeleton__lines" aria-hidden="true">
          <Skeleton />
          <Skeleton width="82%" />
          <Skeleton width="64%" />
        </div>
      </div>
    );
  }

  return (
    <>
      {resource.status === "error" ? (
        <InlineAlert
          variant="error"
          title={t("resource.loadFailed")}
          action={<Button size="small" onClick={onRetry}>{t("resource.retry")}</Button>}
        >
          {resource.error}
        </InlineAlert>
      ) : null}
      {resource.status === "loading" && hasData ? (
        <div className="resource-refreshing" role="status">
          <Spinner size={14} />
          <span>{t("resource.refreshing")}</span>
        </div>
      ) : null}
      {resource.status === "error" && !hasData ? null : children}
    </>
  );
}
