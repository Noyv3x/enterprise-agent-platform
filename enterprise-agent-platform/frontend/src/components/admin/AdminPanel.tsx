import { useEffect, useState } from "react";
import { usePermissions } from "../../hooks/usePermissions";
import { useResourceState } from "../../hooks/useResourceState";
import { ensureAdminPageResource, hasAdminPageData, refreshAdminPageResource } from "../../data/adminResources";
import { refreshTokenUsage } from "../../data/adminActions";
import { resourceKeys } from "../../data/resourceState";
import { activeAdminPage } from "../../store/selectors";
import { useStore, useStoreHandle } from "../../store/useStore";
import { useI18n } from "../../i18n";
import { EmptyState, PageLayout } from "../ui/beautiful";
import { ResourceStatusView } from "../common/ResourceStatusView";
import { AdminPageHeader } from "./AdminPageHeader";
import { AdminPager } from "./AdminPager";
import { AdminPageContent } from "./AdminPageContent";
import "./admin.css";

export function AdminPanel() {
  const { t } = useI18n();
  const { isAdmin } = usePermissions();
  const store = useStoreHandle();
  const page = useStore(activeAdminPage);
  const hasData = useStore((state) => hasAdminPageData(state, page.id));
  const resourceKey = resourceKeys.admin(page.id);
  const resource = useResourceState(resourceKey);
  const mutationPending = useStore((state) => state.pendingOperations.some((key) => key.startsWith("admin:")));
  const usageRefreshing = useStore((state) => state.pendingOperations.includes("admin:tokens:refresh"));
  const [createOpen, setCreateOpen] = useState(false);
  useEffect(() => { if (isAdmin) void ensureAdminPageResource(store, page.id); }, [isAdmin, page.id, store]);
  useEffect(() => { if (page.id !== "accounts") setCreateOpen(false); }, [page.id]);
  if (!isAdmin) return <EmptyState title={t("admin.access.title")} description={t("admin.access.description")} />;
  const refresh = () => { void (page.id === "tokens" ? refreshTokenUsage(store) : refreshAdminPageResource(store, page.id)); };
  const refreshing = resource.status === "loading" || usageRefreshing;
  return <PageLayout
    header={
      <AdminPageHeader
        page={page}
        refreshing={refreshing}
        onRefresh={refresh}
        refreshDisabled={mutationPending || refreshing}
        onCreateAccount={page.id === "accounts" ? () => setCreateOpen(true) : undefined}
      />
    }
    navigation={<AdminPager activeId={page.id} />}
  >
    <ResourceStatusView resourceKey={resourceKey} hasData={hasData || resource.updatedAt !== null} onRetry={() => { void refreshAdminPageResource(store, page.id); }}>
      <div inert={refreshing} aria-busy={refreshing}>
        <AdminPageContent pageId={page.id} accountCreateOpen={createOpen} onCloseAccountCreate={() => setCreateOpen(false)} />
      </div>
    </ResourceStatusView>
  </PageLayout>;
}
