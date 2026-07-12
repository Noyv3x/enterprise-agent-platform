/* <AdminPager/> — the sticky tab strip over ADMIN_PAGES (legacy renderAdminPager,
   legacy-app.js:1367-1386). On mobile the active tab is scrolled into view, the
   React replacement for legacy syncActiveAdminPager (legacy-app.js:299): a
   useEffect keyed on [activeAdminPage, isMobile] + a ref on the active item. */

import { useEffect, useRef } from "react";
import { ADMIN_PAGES } from "../../lib/constants";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import type { AdminPageId } from "../../types";
import { AdminPagerItem } from "./AdminPagerItem";
import { useI18n } from "../../i18n";

export function AdminPager({ activeId }: { activeId: AdminPageId }) {
  const { t } = useI18n();
  const isMobile = useMediaQuery("(max-width: 800px)");
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isMobile) {
      activeRef.current?.scrollIntoView({ block: "nearest", inline: "center" });
    }
  }, [activeId, isMobile]);

  return (
    <nav className="admin-pager" aria-label={t("admin.pager.ariaLabel")}>
      {ADMIN_PAGES.map((page) => {
        const active = page.id === activeId;
        return (
          <AdminPagerItem
            key={page.id}
            page={page}
            active={active}
            buttonRef={active ? activeRef : undefined}
          />
        );
      })}
    </nav>
  );
}
