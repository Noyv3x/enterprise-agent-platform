/* Grouped administration navigation. Desktop renders four labelled groups in a
   secondary sidebar. Mobile renders one compact page selector with optgroups. */

import { Menu, Select, type MenuProps } from "antd";
import { ADMIN_PAGES } from "../../lib/constants";
import { selectAdminPage } from "../../data/adminActions";
import type { AdminPageId } from "../../types";
import { useStoreHandle } from "../../store/useStore";
import { useI18n } from "../../i18n";
import { Icon } from "../common/Icon";
import { AdminPageBadge } from "./AdminPageBadge";

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
  const menuItems: MenuProps["items"] = ADMIN_PAGE_GROUPS.map((group) => ({
    type: "group",
    key: `group-${group.id}`,
    label: t(`admin.group.${group.id}`),
    children: group.pages.flatMap((pageId) => {
      const page = pagesById.get(pageId);
      return page ? [{
        key: page.id,
        icon: <Icon name={page.icon} size={17} />,
        label: (
          <span className="eap-admin-nav__item-label">
            <span>{t(`admin.page.${page.id}.label`)}</span>
            <AdminPageBadge pageId={page.id} />
          </span>
        ),
      }] : [];
    }),
  }));
  const selectOptions = ADMIN_PAGE_GROUPS.map((group) => ({
    label: t(`admin.group.${group.id}`),
    options: group.pages.flatMap((pageId) => {
      const page = pagesById.get(pageId);
      return page ? [{ value: page.id, label: t(`admin.page.${page.id}.label`) }] : [];
    }),
  }));

  return (
    <>
      <nav className="eap-admin-nav" aria-label={t("admin.pager.ariaLabel")}>
        <Menu
          mode="inline"
          inlineIndent={12}
          items={menuItems}
          selectedKeys={[activeId]}
          onClick={({ key }) => void selectAdminPage(store, key as AdminPageId)}
        />
      </nav>
      <div className="eap-admin-page-switcher">
        <label htmlFor="admin-page-select">{t("admin.pager.mobileLabel")}</label>
        <Select
          id="admin-page-select"
          styles={{ input: { minHeight: 0 } }}
          value={activeId}
          options={selectOptions}
          onChange={(value) => void selectAdminPage(store, value as AdminPageId)}
          popupMatchSelectWidth
        />
      </div>
    </>
  );
}
