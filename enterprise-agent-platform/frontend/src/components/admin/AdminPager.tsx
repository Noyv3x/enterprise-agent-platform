/* Grouped administration navigation. Desktop renders four labelled groups in a
   secondary sidebar. Mobile renders one compact page selector with optgroups. */

import { ADMIN_PAGES } from "../../lib/constants";
import { selectAdminPage } from "../../data/adminActions";
import type { AdminPageId } from "../../types";
import { useStoreHandle } from "../../store/useStore";
import { AdminPagerItem } from "./AdminPagerItem";
import { useI18n } from "../../i18n";

export type AdminGroupId = "people" | "agents" | "system" | "advanced";

export const ADMIN_PAGE_GROUPS: ReadonlyArray<{
  id: AdminGroupId;
  pages: readonly AdminPageId[];
}> = [
  { id: "people", pages: ["accounts", "tokens", "messages"] },
  { id: "agents", pages: ["agent-runtime", "telegram"] },
  { id: "system", pages: ["updates", "security", "runtime"] },
  { id: "advanced", pages: ["cognee", "secrets"] },
];

export function AdminPager({ activeId }: { activeId: AdminPageId }) {
  const { t } = useI18n();
  const store = useStoreHandle();
  const pagesById = new Map(ADMIN_PAGES.map((page) => [page.id, page]));

  return (
    <>
      <nav className="admin-pager admin-pager--desktop" aria-label={t("admin.pager.ariaLabel")}>
        {ADMIN_PAGE_GROUPS.map((group) => (
          <div className="admin-pager__group" key={group.id}>
            <div className="admin-pager__group-label">{t(`admin.group.${group.id}`)}</div>
            <div className="admin-pager__group-items">
              {group.pages.map((pageId) => {
                const page = pagesById.get(pageId);
                return page ? (
                  <AdminPagerItem key={page.id} page={page} active={page.id === activeId} />
                ) : null;
              })}
            </div>
          </div>
        ))}
      </nav>
      <div className="admin-pager-mobile">
        <label htmlFor="admin-page-select">{t("admin.pager.mobileLabel")}</label>
        <select
          id="admin-page-select"
          value={activeId}
          onChange={(event) => void selectAdminPage(store, event.target.value as AdminPageId)}
        >
          {ADMIN_PAGE_GROUPS.map((group) => (
            <optgroup key={group.id} label={t(`admin.group.${group.id}`)}>
              {group.pages.map((pageId) => {
                const page = pagesById.get(pageId);
                return page ? (
                  <option key={page.id} value={page.id}>
                    {t(`admin.page.${page.id}.label`)}
                  </option>
                ) : null;
              })}
            </optgroup>
          ))}
        </select>
      </div>
    </>
  );
}
