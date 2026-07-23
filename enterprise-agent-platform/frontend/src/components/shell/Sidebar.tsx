/* <Sidebar/> — brand head + workspace nav + channel list/create + user foot
   (legacy renderSidebar, legacy-app.js:439-487). When off-canvas (mobile +
   closed) the <aside> is inert + aria-hidden so its controls are neither
   focusable nor announced — recomputed across the 800px breakpoint by the
   caller's useMediaQuery. */

import { Badge, Menu } from "antd";
import { navigateToView } from "../../data/chatActions";
import { usePermissions } from "../../hooks/usePermissions";
import { useI18n } from "../../i18n";
import { useStore, useStoreHandle } from "../../store/useStore";
import { cx } from "../../lib/cx";
import { Brand } from "../common/Brand";
import { Icon } from "../common/Icon";
import { ChannelCreateForm } from "./ChannelCreateForm";
import { ChannelList } from "./ChannelList";
import { SidebarFoot } from "./SidebarFoot";
import { WorkspaceNav } from "./WorkspaceNav";
import { preloadRoute } from "./routePreload";

export function Sidebar({ showBrand = true }: { showBrand?: boolean }) {
  const store = useStoreHandle();
  const { t } = useI18n();
  const channelCount = useStore((state) => state.channels.length);
  const activeView = useStore((state) => state.activeView);
  const permissions = usePermissions();
  const canManageChannels = permissions.has("manage_channels");

  return (
    <aside
      className={cx("sidebar", !showBrand && "sidebar--drawer")}
      id="app-sidebar"
    >
      {showBrand ? <div className="sidebar__head"><Brand /></div> : null}
      <div className="sidebar__scroll">
        <div>
          <div className="section-label">
            <span>{t("nav.channels")}</span>
            <Badge
              className="nav__badge"
              classNames={{ indicator: "nav__badge-indicator" }}
              count={channelCount}
              showZero
              size="small"
            />
          </div>
          <ChannelList />
          {canManageChannels ? <ChannelCreateForm /> : null}
        </div>
        <div>
          <div className="section-label">{t("nav.workspace")}</div>
          <WorkspaceNav />
        </div>
        {permissions.isAdmin ? (
          <div className="sidebar__tools">
            <div className="section-label">{t("shell.tools")}</div>
            <nav className="nav" aria-label={t("shell.tools")}>
              <Menu
                className="shell-menu"
                mode="inline"
                selectable
                selectedKeys={activeView === "admin" ? ["admin"] : []}
                classNames={{
                  item: "shell-menu__item",
                  itemIcon: "shell-menu__icon",
                  itemContent: "shell-menu__content",
                }}
                items={[{
                  key: "admin",
                  icon: <Icon name="shield" />,
                  label: (
                    <span
                      className="shell-menu__label"
                      onPointerEnter={() => preloadRoute("admin")}
                      onTouchStart={() => preloadRoute("admin")}
                    >
                      {t("nav.admin")}
                    </span>
                  ),
                }]}
                onClick={() => void navigateToView(store, "admin")}
              />
            </nav>
          </div>
        ) : null}
      </div>
      <SidebarFoot />
    </aside>
  );
}
