/* <NavItem/> — one workspace nav button (legacy navItem, legacy-app.js:489-501).
   Clicking it switches the view + closes the drawer + fires the view's loader
   via navigateToView. */

import { cx } from "../../lib/cx";
import { navigateToView } from "../../data/chatActions";
import { useStoreHandle } from "../../store/useStore";
import type { ActiveView, IconName } from "../../types";
import { Icon } from "../common/Icon";

export interface NavItemProps {
  view: ActiveView;
  label: string;
  icon: IconName;
  active: boolean;
}

export function NavItem({ view, label, icon, active }: NavItemProps) {
  const store = useStoreHandle();
  return (
    <button
      className={cx("nav__item", active && "is-active")}
      onClick={() => void navigateToView(store, view)}
    >
      <Icon name={icon} />
      <span className="nav__label">{label}</span>
    </button>
  );
}
