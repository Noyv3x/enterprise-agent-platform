/* <Sidebar/> — brand head + workspace nav + channel list/create + user foot
   (legacy renderSidebar, legacy-app.js:439-487). When off-canvas (mobile +
   closed) the <aside> is inert + aria-hidden so its controls are neither
   focusable nor announced — recomputed across the 800px breakpoint by the
   caller's useMediaQuery. */

import { usePermissions } from "../../hooks/usePermissions";
import { useI18n } from "../../i18n";
import { useStore } from "../../store/useStore";
import { Brand } from "../common/Brand";
import { ChannelCreateForm } from "./ChannelCreateForm";
import { ChannelList } from "./ChannelList";
import { NavItem } from "./NavItem";
import { SidebarFoot } from "./SidebarFoot";
import { WorkspaceNav } from "./WorkspaceNav";

export function Sidebar({ hidden }: { hidden: boolean }) {
  const { t } = useI18n();
  const channelCount = useStore((state) => state.channels.length);
  const activeView = useStore((state) => state.activeView);
  const permissions = usePermissions();
  const canManageChannels = permissions.has("manage_channels");

  return (
    <aside
      className="sidebar"
      id="app-sidebar"
      inert={hidden}
      aria-hidden={hidden ? "true" : undefined}
    >
      <div className="sidebar__head">
        <Brand />
      </div>
      <div className="sidebar__scroll">
        <div>
          <div className="section-label">
            <span>{t("nav.channels")}</span>
            <span className="nav__badge">{channelCount}</span>
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
              <NavItem
                view="admin"
                label={t("nav.admin")}
                icon="shield"
                active={activeView === "admin"}
              />
            </nav>
          </div>
        ) : null}
      </div>
      <SidebarFoot />
    </aside>
  );
}
