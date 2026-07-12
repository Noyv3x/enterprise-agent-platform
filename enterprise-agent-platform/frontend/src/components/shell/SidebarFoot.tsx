/* <SidebarFoot/> — current-user identity chip + logout (legacy renderSidebarFoot,
   legacy-app.js:504-517). Name/role precedence preserved exactly. */

import { logout } from "../../data/sessionActions";
import { useI18n } from "../../i18n";
import { permissionGroupLabel } from "../../i18n/labels";
import { useStore, useStoreHandle } from "../../store/useStore";
import { initials } from "../../utils/format";
import { Icon } from "../common/Icon";

export function SidebarFoot() {
  const store = useStoreHandle();
  const { t } = useI18n();
  const user = useStore((state) => state.user);
  if (!user) return null;

  const name = user.display_name || user.username || t("nav.userFallback");
  const role =
    user.position ||
    permissionGroupLabel(
      t,
      user.permission_group || user.role || "member",
      user.permission_group_label,
    );

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
        title={t("nav.logout")}
        aria-label={t("nav.logout")}
        onClick={() => void logout(store)}
      >
        <Icon name="logout" />
      </button>
    </div>
  );
}
