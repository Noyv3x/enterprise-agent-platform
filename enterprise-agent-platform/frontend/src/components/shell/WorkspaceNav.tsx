/* Primary workspace destinations. Channels are rendered as their own list;
   settings live in the user menu and admin tools sit at the sidebar bottom. */

import { Menu, type MenuProps } from "antd";
import { navigateToView } from "../../data/chatActions";
import { usePermissions } from "../../hooks/usePermissions";
import { useI18n } from "../../i18n";
import { useStore, useStoreHandle } from "../../store/useStore";
import type { ActiveView, IconName } from "../../types";
import { Icon } from "../common/Icon";
import { preloadRoute } from "./routePreload";

interface NavSpec {
  view: ActiveView;
  label: string;
  icon: IconName;
}

export function WorkspaceNav() {
  const perms = usePermissions();
  const store = useStoreHandle();
  const { t } = useI18n();
  const activeView = useStore((state) => state.activeView);

  const specs: NavSpec[] = [];
  if (perms.has("private_agent")) specs.push({ view: "private", label: t("nav.privateAgent"), icon: "bot" });
  specs.push({ view: "knowledge", label: t("nav.knowledge"), icon: "library" });

  const items: MenuProps["items"] = specs.map((spec) => ({
    key: spec.view,
    icon: <Icon name={spec.icon} />,
    label: (
      <span
        className="shell-menu__label"
        onPointerEnter={() => preloadRoute(spec.view)}
        onTouchStart={() => preloadRoute(spec.view)}
      >
        {spec.label}
      </span>
    ),
  }));

  return (
    <nav className="nav" aria-label={t("shell.navigation")}>
      <Menu
        className="shell-menu"
        mode="inline"
        selectedKeys={specs.some((spec) => spec.view === activeView) ? [activeView] : []}
        items={items}
        classNames={{
          item: "shell-menu__item",
          itemIcon: "shell-menu__icon",
          itemContent: "shell-menu__content",
        }}
        onClick={({ key }) => void navigateToView(store, key as ActiveView)}
      />
    </nav>
  );
}
