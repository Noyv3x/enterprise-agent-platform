import type { ReactNode } from "react";
import { Button } from "antd";
import { useResourceState } from "../../hooks/useResourceState";
import { useI18n } from "../../i18n";
import { DataRegion } from "../ui/fieldwork";

export function ResourceStatusView({ resourceKey, hasData, onRetry, children }: {
  resourceKey: string;
  hasData: boolean;
  onRetry: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const resource = useResourceState(resourceKey);
  const initialLoading = !hasData && (resource.status === "idle" || resource.status === "loading");
  const failed = resource.status === "error";
  const refreshing = hasData && resource.status === "loading";

  return <DataRegion
    state={initialLoading ? "loading" : failed && !hasData ? "error" : "ready"}
    loadingLabel={t("resource.loading")}
    refreshing={refreshing}
    refreshingLabel={t("resource.refreshing")}
    error={failed ? <><strong>{t("resource.loadFailed")}</strong>{resource.error ? <div>{resource.error}</div> : null}</> : undefined}
    retry={failed ? <Button onClick={onRetry}>{t("resource.retry")}</Button> : undefined}
  >
    {children}
  </DataRegion>;
}
