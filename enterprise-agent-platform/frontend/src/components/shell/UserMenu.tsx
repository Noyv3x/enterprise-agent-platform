import { MenuButton } from "../ui/beautiful";
import { logout } from "../../data/sessionActions";
import { useI18n } from "../../i18n";
import { useStore, useStoreHandle } from "../../store/useStore";
import { Icon } from "../common/Icon";

export function UserMenu() {
  const store = useStoreHandle();
  const { t } = useI18n();
  const user = useStore(state => state.user);
  if (!user) return null;
  const name = user.display_name || user.username || t("nav.userFallback");
  return <div className="bui-spread">
      <div className="bui-break"><strong className="bui-account-name">{name}</strong><div className="bui-account-detail">@{user.username}</div>
        {user.position?.trim() ? <div className="bui-account-detail">{user.position.trim()}</div> : null}</div>
      <MenuButton label={<Icon name="logout" />} aria-label={t("shell.userMenu.open")} items={[
        { key: "logout", label: t("nav.logout"), danger: true, onSelect: () => { void logout(store); } },
      ]} />
  </div>;
}
