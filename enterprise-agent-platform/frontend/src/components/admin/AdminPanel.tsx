/* <AdminPanel/> — the top-level admin view (legacy renderAdminPanel,
   legacy-app.js:1342-1361). Permission-gated (isAdmin), then pager + active page
   header + content. ContentRouter renders this at the admin placeholder. */

import { useEffect, useState } from "react";
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
import "./admin.css";

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
  const [accountCreateOpen, setAccountCreateOpen] = useState(false);

  useEffect(() => {
    if (isAdmin) void ensureAdminPageResource(store, page.id);
  }, [isAdmin, page.id, store]);

  useEffect(() => {
    if (page.id !== "accounts") setAccountCreateOpen(false);
  }, [page.id]);

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
    <div className="panel eap-admin-shell">
      <div className="eap-admin-layout">
        <AdminPager activeId={page.id} />
        <section
          className={cx("eap-admin-page", `eap-admin-page--${page.id}`)}
          aria-labelledby={`admin-page-${page.id}-title`}
        >
          <AdminPageHeader
            page={page}
            refreshing={resource.status === "loading"}
            onRefresh={() => void refreshAdminPageResource(store, page.id)}
            refreshDisabled={mutationPending}
            onCreateAccount={page.id === "accounts" ? () => setAccountCreateOpen(true) : undefined}
          />
          <div
            className="eap-admin-page__content"
            inert={resource.status === "loading" && dataPresent}
            aria-busy={resource.status === "loading" || mutationPending}
          >
            <ResourceStatusView
              resourceKey={resourceKey}
              hasData={dataPresent || resource.updatedAt !== null}
              onRetry={() => void refreshAdminPageResource(store, page.id)}
            >
              <AdminPageContent
                pageId={page.id}
                accountCreateOpen={accountCreateOpen}
                onCloseAccountCreate={() => setAccountCreateOpen(false)}
              />
            </ResourceStatusView>
          </div>
        </section>
      </div>
    </div>
  );
}
