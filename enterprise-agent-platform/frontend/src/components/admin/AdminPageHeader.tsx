/* <AdminPageHeader/> — the active page eyebrow/title/description + position
   indicator (legacy renderAdminPanel head block, legacy-app.js:1349-1356). */

import { ADMIN_PAGES } from "../../lib/constants";
import type { AdminPage } from "../../types";

export function AdminPageHeader({ page, index }: { page: AdminPage; index: number }) {
  return (
    <div className="admin-page__head">
      <div>
        <div className="eyebrow">管理分页</div>
        <h2>{page.label}</h2>
        <p>{page.description}</p>
      </div>
      <span className="status">{`${index + 1}/${ADMIN_PAGES.length}`}</span>
    </div>
  );
}
