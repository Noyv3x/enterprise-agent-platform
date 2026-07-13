/* <AdminPanel/> — the top-level admin view (legacy renderAdminPanel,
   legacy-app.js:1342-1361). Permission-gated (isAdmin), then pager + active page
   header + content. ContentRouter renders this at the admin placeholder. */

import { useEffect } from "react";
import { usePermissions } from "../../hooks/usePermissions";
import { useResourceState } from "../../hooks/useResourceState";
import { hasAdminPageData, ensureAdminPageResource, refreshAdminPageResource } from "../../data/adminResources";
import { resourceKeys } from "../../data/resourceState";
import { activeAdminPage } from "../../store/selectors";
import { useStore, useStoreHandle } from "../../store/useStore";
import { cx } from "../../lib/cx";
import { EmptyState } from "../common/EmptyState";
import { ResourceStatusView } from "../common/ResourceStatusView";
import { AdminPageContent } from "./AdminPageContent";
import { AdminPageHeader } from "./AdminPageHeader";
import { AdminPager } from "./AdminPager";
import { useI18n } from "../../i18n";

export function AdminPanel() {
  const { t } = useI18n();
  const { isAdmin } = usePermissions();
  // activeAdminPage() returns the same object reference from ADMIN_PAGES while the
  // id is unchanged, so the selector is Object.is-stable across renders.
  const page = useStore(activeAdminPage);
  const store = useStoreHandle();
  const dataPresent = useStore((state) => hasAdminPageData(state, page.id));
  const resourceKey = resourceKeys.admin(page.id);
  const resource = useResourceState(resourceKey);
  const mutationPending = useStore((state) =>
    state.pendingOperations.some((key) => key.startsWith("admin:")),
  );

  useEffect(() => {
    if (isAdmin) void ensureAdminPageResource(store, page.id);
  }, [isAdmin, page.id, store]);

  if (!isAdmin) {
    return (
      <EmptyState
        icon="shield"
        title={t("admin.access.title")}
        text={t("admin.access.description")}
      />
    );
  }

  return (
    <div className="panel">
      <div className="panel__inner admin-panel">
        <AdminPager activeId={page.id} />
        <div className={cx("admin-page", `admin-page--${page.id}`)}>
          <AdminPageHeader
            page={page}
            refreshing={resource.status === "loading"}
            onRefresh={() => void refreshAdminPageResource(store, page.id)}
            refreshDisabled={mutationPending}
          />
          <div
            className="admin-page__content"
            inert={resource.status === "loading" && dataPresent}
            aria-busy={resource.status === "loading" || mutationPending}
          >
            <ResourceStatusView
              resourceKey={resourceKey}
              hasData={dataPresent || resource.updatedAt !== null}
              onRetry={() => void refreshAdminPageResource(store, page.id)}
            >
              <AdminPageContent pageId={page.id} />
            </ResourceStatusView>
          </div>
        </div>
      </div>
    </div>
  );
}
