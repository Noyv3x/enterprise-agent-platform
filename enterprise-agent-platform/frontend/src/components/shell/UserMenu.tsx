import { useEffect, useId, useRef, useState } from "react";
import { navigateToView } from "../../data/chatActions";
import { preloadRoute } from "./routePreload";
import { logout } from "../../data/sessionActions";
import { useTheme } from "../../hooks/useTheme";
import { SUPPORTED_LOCALES, useI18n, type Locale } from "../../i18n";
import { permissionGroupLabel } from "../../i18n/labels";
import { useStore, useStoreHandle } from "../../store/useStore";
import { initials } from "../../utils/format";
import { Icon } from "../common/Icon";
import { LOCALE_NAMES } from "../common/LanguageSelect";

const MENU_CONTROLS =
  'button:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function UserMenu() {
  const store = useStoreHandle();
  const { locale, setLocale, t } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const user = useStore((state) => state.user);
  const activeView = useStore((state) => state.activeView);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const previousView = useRef(activeView);

  useEffect(() => {
    if (previousView.current !== activeView) setOpen(false);
    previousView.current = activeView;
  }, [activeView]);

  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLElement>(`.user-menu__popover ${MENU_CONTROLS}`)?.focus();

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

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
    <div className="user-menu" ref={rootRef}>
      {open ? (
        <div className="user-menu__popover" id={menuId} role="dialog" aria-label={name}>
          <div className="user-menu__identity">
            <strong>{name}</strong>
            <span>{role}</span>
          </div>
          <button
            className="user-menu__item"
            type="button"
            onClick={() => void navigateToView(store, "settings")}
            onPointerEnter={() => preloadRoute("settings")}
            onFocus={() => preloadRoute("settings")}
          >
            <Icon name="settings" />
            <span>{t("shell.userMenu.settings")}</span>
          </button>
          <div className="user-menu__field" role="group" aria-label={t("shell.userMenu.language")}>
            <span>{t("shell.userMenu.language")}</span>
            <div className="user-menu__locales">
              {SUPPORTED_LOCALES.map((item) => (
                <button
                  key={item}
                  className="user-menu__locale"
                  type="button"
                  aria-pressed={locale === item}
                  onClick={() => setLocale(item as Locale)}
                >
                  {LOCALE_NAMES[item]}
                </button>
              ))}
            </div>
          </div>
          <button
            className="user-menu__item"
            type="button"
            aria-pressed={theme === "dark"}
            onClick={toggleTheme}
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} />
            <span>{t("shell.userMenu.theme")}</span>
            <span className="user-menu__switch" aria-hidden="true" />
          </button>
          <div className="user-menu__separator" aria-hidden="true" />
          <button
            className="user-menu__item user-menu__item--danger"
            type="button"
            onClick={() => void logout(store)}
          >
            <Icon name="logout" />
            <span>{t("nav.logout")}</span>
          </button>
        </div>
      ) : null}
      <button
        ref={triggerRef}
        className="user-menu__trigger"
        type="button"
        aria-label={t("shell.userMenu.open")}
        aria-haspopup="dialog"
        aria-controls={menuId}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="avatar" aria-hidden="true">{initials(name)}</span>
        <span className="user__meta">
          <span className="user__name">{name}</span>
          <span className="user__role">{role}</span>
        </span>
        <Icon name="settings" cls="user-menu__trigger-icon" />
      </button>
    </div>
  );
}
