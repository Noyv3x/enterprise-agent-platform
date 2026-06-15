/* <Sidebar/> — brand head + workspace nav + channel list/create + user foot
   (legacy renderSidebar, legacy-app.js:439-487). When off-canvas (mobile +
   closed) the <aside> is inert + aria-hidden so its controls are neither
   focusable nor announced — recomputed across the 800px breakpoint by the
   caller's useMediaQuery. */

import { usePermissions } from "../../hooks/usePermissions";
import { useStore } from "../../store/useStore";
import { Brand } from "../common/Brand";
import { ChannelCreateForm } from "./ChannelCreateForm";
import { ChannelList } from "./ChannelList";
import { SidebarFoot } from "./SidebarFoot";
import { WorkspaceNav } from "./WorkspaceNav";

export function Sidebar({ hidden }: { hidden: boolean }) {
  const channelCount = useStore((state) => state.channels.length);
  const canManageChannels = usePermissions().has("manage_channels");

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
          <div className="section-label">工作区</div>
          <WorkspaceNav />
        </div>
        <div>
          <div className="section-label">
            <span>频道</span>
            <span className="nav__badge">{channelCount}</span>
          </div>
          <ChannelList />
          {canManageChannels ? <ChannelCreateForm /> : null}
        </div>
      </div>
      <SidebarFoot />
    </aside>
  );
}
