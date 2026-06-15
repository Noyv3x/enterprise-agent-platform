/* <AdminPanel/> — the top-level admin view (legacy renderAdminPanel,
   legacy-app.js:1342-1361). Permission-gated (isAdmin), then pager + active page
   header + content. ContentRouter renders this at the admin placeholder. */

import { ADMIN_PAGES } from "../../lib/constants";
import { usePermissions } from "../../hooks/usePermissions";
import { activeAdminPage } from "../../store/selectors";
import { useStore } from "../../store/useStore";
import { cx } from "../../lib/cx";
import { EmptyState } from "../common/EmptyState";
import { AdminPageContent } from "./AdminPageContent";
import { AdminPageHeader } from "./AdminPageHeader";
import { AdminPager } from "./AdminPager";

export function AdminPanel() {
  const { isAdmin } = usePermissions();
  // activeAdminPage() returns the same object reference from ADMIN_PAGES while the
  // id is unchanged, so the selector is Object.is-stable across renders.
  const page = useStore(activeAdminPage);

  if (!isAdmin) {
    return (
      <EmptyState
        icon="shield"
        title="需要管理员权限"
        text="请使用管理员账户登录后访问管理面板。"
      />
    );
  }

  const index = ADMIN_PAGES.findIndex((item) => item.id === page.id);

  return (
    <div className="panel">
      <div className="panel__inner admin-panel">
        <AdminPager activeId={page.id} />
        <div className={cx("admin-page", `admin-page--${page.id}`)}>
          <AdminPageHeader page={page} index={index} />
          <div className="admin-page__content">
            <AdminPageContent pageId={page.id} />
          </div>
        </div>
      </div>
    </div>
  );
}
