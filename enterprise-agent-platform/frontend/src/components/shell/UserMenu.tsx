import { Button, Dropdown } from "antd";
import { useState } from "react";
import { logout } from "../../data/sessionActions";
import { useI18n } from "../../i18n";
import { useStore, useStoreHandle } from "../../store/useStore";
import { Icon } from "../common/Icon";

export function UserMenu() {
  const store = useStoreHandle();
  const { t } = useI18n();
  const user = useStore(state => state.user);
  const [open, setOpen] = useState(false);
  if (!user) return null;
  const name = user.display_name || user.username || t("nav.userFallback");
  return <div className="wf-spread">
      <div className="wf-break"><strong className="wf-account-name">{name}</strong><div className="wf-account-detail">@{user.username}</div>
        {user.position?.trim() ? <div className="wf-account-detail">{user.position.trim()}</div> : null}</div>
      <Dropdown trigger={["click"]} open={open} onOpenChange={setOpen} menu={{ items: [
        { key: "logout", label: t("nav.logout"), icon: <Icon name="logout" />, danger: true },
      ], onClick: () => { setOpen(false); void logout(store); } }}>
        <Button type="text" icon={<Icon name="logout" />} aria-label={t("shell.userMenu.open")} aria-expanded={open} />
      </Dropdown>
  </div>;
}
