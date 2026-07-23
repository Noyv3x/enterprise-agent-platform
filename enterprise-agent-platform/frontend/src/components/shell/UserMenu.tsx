import { Avatar, Button, Dropdown, Menu, Segmented, Switch } from "antd";
import { useEffect, useId, useRef, useState } from "react";
import { navigateToView } from "../../data/chatActions";
import { logout } from "../../data/sessionActions";
import { useTheme } from "../../hooks/useTheme";
import { SUPPORTED_LOCALES, useI18n, type Locale } from "../../i18n";
import { permissionGroupLabel } from "../../i18n/labels";
import { useStore, useStoreHandle } from "../../store/useStore";
import { initials } from "../../utils/format";
import { Icon } from "../common/Icon";
import { LOCALE_NAMES } from "../common/LanguageSelect";
import { preloadRoute } from "./routePreload";

export function UserMenu() {
  const store = useStoreHandle();
  const { locale, setLocale, t } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const user = useStore((state) => state.user);
  const activeView = useStore((state) => state.activeView);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const previousView = useRef(activeView);

  useEffect(() => {
    if (previousView.current !== activeView) setOpen(false);
    previousView.current = activeView;
  }, [activeView]);

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
    <div className="user-menu">
      <Dropdown
        open={open}
        onOpenChange={setOpen}
        trigger={["click"]}
        placement="topLeft"
        autoFocus
        destroyOnHidden
        classNames={{ root: "shell-user-menu-popup" }}
        popupRender={() => (
          <div className="user-menu__popover" id={menuId} aria-label={name}>
            <div className="user-menu__identity">
              <strong>{name}</strong>
              <span>{role}</span>
            </div>
            <Menu
              className="user-menu__menu"
              selectable={false}
              items={[{
                key: "settings",
                icon: <Icon name="settings" />,
                label: t("shell.userMenu.settings"),
              }]}
              onClick={() => {
                setOpen(false);
                void navigateToView(store, "settings");
              }}
            />
            <div className="user-menu__field" role="group" aria-label={t("shell.userMenu.language")}>
              <span>{t("shell.userMenu.language")}</span>
              <Segmented
                block
                size="small"
                classNames={{ label: "user-menu__locale-label" }}
                aria-label={t("shell.userMenu.language")}
                value={locale}
                options={SUPPORTED_LOCALES.map((item) => ({
                  value: item,
                  label: LOCALE_NAMES[item],
                }))}
                onChange={(value) => setLocale(value as Locale)}
              />
            </div>
            <div className="user-menu__field user-menu__field--switch">
              <span className="user-menu__theme-label">
                <Icon name={theme === "dark" ? "sun" : "moon"} />
                {t("shell.userMenu.theme")}
              </span>
              <Switch
                size="small"
                checked={theme === "dark"}
                aria-label={t("shell.userMenu.theme")}
                onChange={toggleTheme}
              />
            </div>
            <Menu
              className="user-menu__menu user-menu__menu--danger"
              selectable={false}
              items={[{
                key: "logout",
                danger: true,
                icon: <Icon name="logout" />,
                label: t("nav.logout"),
              }]}
              onClick={() => {
                setOpen(false);
                void logout(store);
              }}
            />
          </div>
        )}
        menu={{ items: [] }}
      >
        <Button
          className="user-menu__trigger"
          type="text"
          block
          aria-label={t("shell.userMenu.open")}
          aria-haspopup="menu"
          aria-controls={menuId}
          aria-expanded={open}
          onPointerEnter={() => preloadRoute("settings")}
          onFocus={() => preloadRoute("settings")}
        >
          <Avatar className="user-menu__avatar" size={32}>{initials(name)}</Avatar>
          <span className="user__meta">
            <span className="user__name">{name}</span>
            <span className="user__role">{role}</span>
          </span>
          <Icon name="settings" cls="user-menu__trigger-icon" />
        </Button>
      </Dropdown>
    </div>
  );
}
