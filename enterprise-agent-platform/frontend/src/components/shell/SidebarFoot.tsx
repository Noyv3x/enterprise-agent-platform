/* <SidebarFoot/> — current-user identity chip + logout (legacy renderSidebarFoot,
   legacy-app.js:504-517). Name/role precedence preserved exactly. */

import { logout } from "../../data/sessionActions";
import { useStore, useStoreHandle } from "../../store/useStore";
import { initials } from "../../utils/format";
import { Icon } from "../common/Icon";

export function SidebarFoot() {
  const store = useStoreHandle();
  const user = useStore((state) => state.user);
  if (!user) return null;

  const name = user.display_name || user.username || "用户";
  const role =
    user.position || user.permission_group_label || (user.role || "member").toUpperCase();

  return (
    <div className="sidebar__foot">
      <div className="user">
        <div className="avatar">{initials(name)}</div>
        <div className="user__meta">
          <span className="user__name">{name}</span>
          <span className="user__role">{role}</span>
        </div>
      </div>
      <button
        className="icon-btn"
        title="退出登录"
        aria-label="退出登录"
        onClick={() => void logout(store)}
      >
        <Icon name="logout" />
      </button>
    </div>
  );
}
