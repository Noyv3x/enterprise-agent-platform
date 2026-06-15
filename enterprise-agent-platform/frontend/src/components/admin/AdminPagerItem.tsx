/* <AdminPagerItem/> — one sticky tab in the admin pager (legacy renderAdminPager
   button, legacy-app.js:1370-1384). aria-current="page" only when active (the
   legacy h() drops null attributes). Clicking switches the page and lazily loads
   messages/tokens via selectAdminPage. */

import type { Ref } from "react";
import { cx } from "../../lib/cx";
import { selectAdminPage } from "../../data/adminActions";
import { useStoreHandle } from "../../store/useStore";
import type { AdminPage } from "../../types";
import { Icon } from "../common/Icon";
import { AdminPageBadge } from "./AdminPageBadge";

export interface AdminPagerItemProps {
  page: AdminPage;
  active: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
}

export function AdminPagerItem({ page, active, buttonRef }: AdminPagerItemProps) {
  const store = useStoreHandle();
  return (
    <button
      ref={buttonRef}
      className={cx("admin-pager__item", active && "is-active")}
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={() => void selectAdminPage(store, page.id)}
    >
      <Icon name={page.icon} size={16} />
      <span>{page.label}</span>
      <AdminPageBadge pageId={page.id} />
    </button>
  );
}
