/* <WorkspaceNav/> — the permission-gated workspace nav (legacy navSpecs,
   legacy-app.js:440-446). Order: 频道, [私人 Agent], 知识库, 设置, [管理面板];
   private requires the private_agent permission, admin requires isAdmin. */

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

  const specs: NavSpec[] = [{ view: "channel", label: t("nav.channels"), icon: "hash" }];
  if (perms.has("private_agent")) specs.push({ view: "private", label: t("nav.privateAgent"), icon: "bot" });
  specs.push({ view: "knowledge", label: t("nav.knowledge"), icon: "library" });
  specs.push({ view: "settings", label: t("nav.settings"), icon: "settings" });
  if (perms.isAdmin) specs.push({ view: "admin", label: t("nav.admin"), icon: "shield" });

  return (
    <nav className="nav">
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
