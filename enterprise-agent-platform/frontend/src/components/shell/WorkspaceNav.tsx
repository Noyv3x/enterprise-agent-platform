/* <WorkspaceNav/> — the permission-gated workspace nav (legacy navSpecs,
   legacy-app.js:440-446). Order: 频道, [私人 Agent], 知识库, 设置, [管理面板];
   private requires the private_agent permission, admin requires isAdmin. */

import { usePermissions } from "../../hooks/usePermissions";
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
  const activeView = useStore((state) => state.activeView);

  const specs: NavSpec[] = [{ view: "channel", label: "频道", icon: "hash" }];
  if (perms.has("private_agent")) specs.push({ view: "private", label: "私人 Agent", icon: "bot" });
  specs.push({ view: "knowledge", label: "知识库", icon: "library" });
  specs.push({ view: "settings", label: "设置", icon: "settings" });
  if (perms.isAdmin) specs.push({ view: "admin", label: "管理面板", icon: "shield" });

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
