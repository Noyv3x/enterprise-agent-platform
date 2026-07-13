/* Primary workspace destinations. Channels are rendered as their own list;
   settings live in the user menu and admin tools sit at the sidebar bottom. */

import { usePermissions } from "../../hooks/usePermissions";
import { useI18n } from "../../i18n";
import { useStore } from "../../store/useStore";
import type { ActiveView, IconName } from "../../types";
import { NavItem } from "./NavItem";

interface NavSpec {
  view: ActiveView;
  label: string;
  icon: IconName;
}

export function WorkspaceNav() {
  const perms = usePermissions();
  const { t } = useI18n();
  const activeView = useStore((state) => state.activeView);

  const specs: NavSpec[] = [];
  if (perms.has("private_agent")) specs.push({ view: "private", label: t("nav.privateAgent"), icon: "bot" });
  specs.push({ view: "knowledge", label: t("nav.knowledge"), icon: "library" });

  return (
    <nav className="nav" aria-label={t("shell.navigation")}>
      {specs.map((spec) => (
        <NavItem
          key={spec.view}
          view={spec.view}
          label={spec.label}
          icon={spec.icon}
          active={activeView === spec.view}
        />
      ))}
    </nav>
  );
}
