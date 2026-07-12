/* <AdminPageHeader/> — the active page eyebrow/title/description + position
   indicator (legacy renderAdminPanel head block, legacy-app.js:1349-1356). */

import { ADMIN_PAGES } from "../../lib/constants";
import { useI18n } from "../../i18n";
import type { AdminPage } from "../../types";

export function AdminPageHeader({ page, index }: { page: AdminPage; index: number }) {
  const { t } = useI18n();
  return (
    <div className="admin-page__head">
      <div>
        <div className="eyebrow">{t("admin.header.eyebrow")}</div>
        <h2>{t(`admin.page.${page.id}.label`)}</h2>
        <p>{t(`admin.page.${page.id}.description`)}</p>
      </div>
      <span className="status">{`${index + 1}/${ADMIN_PAGES.length}`}</span>
    </div>
  );
}
