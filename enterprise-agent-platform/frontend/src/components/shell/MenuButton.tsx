/* <MenuButton/> — the mobile hamburger that opens the drawer (legacy-app.js:526).
   Desktop CSS hides it (.menu-btn display:none). aria-expanded reflects the
   drawer state; aria-controls ties it to the sidebar. Opening focus-moves into
   the drawer via the AppShell open/close effect. */

import { useStore, useStoreHandle } from "../../store/useStore";
import { Icon } from "../common/Icon";

export function MenuButton() {
  const store = useStoreHandle();
  const sidebarOpen = useStore((state) => state.sidebarOpen);
  return (
    <button
      className="icon-btn menu-btn"
      title="打开菜单"
      aria-label="打开菜单"
      aria-expanded={sidebarOpen}
      aria-controls="app-sidebar"
      onClick={() => store.dispatch({ type: "SET_SIDEBAR_OPEN", payload: true })}
    >
      <Icon name="menu" />
    </button>
  );
}
