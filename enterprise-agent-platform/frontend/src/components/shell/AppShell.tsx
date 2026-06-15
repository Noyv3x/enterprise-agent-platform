/* <AppShell/> — the authenticated two-column layout (legacy renderShell,
   legacy-app.js:407-415): <Sidebar/> + <Scrim/> + main column (<Topbar/> +
   <ContentRouter/>).

   Owns the mobile drawer:
   - sidebarOpen lives in the store (ui slice); is-open class drives the CSS slide.
   - useMediaQuery(800px) computes whether the sidebar is off-canvas → the Sidebar
     gets inert + aria-hidden, recomputed across the breakpoint exactly like the
     legacy matchMedia change listener.
   - Focus management is a deterministic useEffect (replacing the legacy RAF):
     open → focus the first .nav__item in the drawer; close → restore focus to the
     .menu-btn that opened it (legacy openSidebar/closeSidebar, :423-437).
   - Escape closes the drawer while open (legacy global listener, :3488-3493).

   The SSE stream + 4s poll are shell-owned (legacy syncScopeStream/startPolling
   ran globally from afterRender/boot, not per chat view), so useRealtime +
   usePolling mount here and track the active scope.

   A11y improvement (deviation from strict legacy parity): the <main> column is
   marked inert + aria-hidden while the mobile drawer is open, giving a real focus
   trap behind the overlay. The legacy code left <main> focusable. */

import { useEffect, useRef } from "react";
import { cx } from "../../lib/cx";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { usePolling } from "../../hooks/usePolling";
import { useRealtime } from "../../hooks/useRealtime";
import { useStore, useStoreHandle } from "../../store/useStore";
import { ContentRouter } from "./ContentRouter";
import { Scrim } from "./Scrim";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

export function AppShell() {
  const store = useStoreHandle();
  const sidebarOpen = useStore((state) => state.sidebarOpen);
  const isMobile = useMediaQuery("(max-width: 800px)");

  // Shell-owned realtime + safety-net poll for the active scope.
  useRealtime();
  usePolling();

  const closeSidebar = () => store.dispatch({ type: "SET_SIDEBAR_OPEN", payload: false });

  // Deterministic focus management on drawer open/close (replaces the legacy RAF).
  const prevOpen = useRef(false);
  useEffect(() => {
    const wasOpen = prevOpen.current;
    prevOpen.current = sidebarOpen;
    if (sidebarOpen && !wasOpen) {
      document.getElementById("app-sidebar")?.querySelector<HTMLElement>(".nav__item")?.focus();
    } else if (!sidebarOpen && wasOpen) {
      document.querySelector<HTMLElement>(".menu-btn")?.focus();
    }
  }, [sidebarOpen]);

  // Escape closes the open drawer (keyboard parity).
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        store.dispatch({ type: "SET_SIDEBAR_OPEN", payload: false });
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [sidebarOpen, store]);

  const drawerOffCanvas = !sidebarOpen && isMobile;
  const overlayActive = sidebarOpen && isMobile;

  return (
    <div className={cx("shell", sidebarOpen && "is-open")}>
      <Sidebar hidden={drawerOffCanvas} />
      <Scrim open={sidebarOpen} onClose={closeSidebar} />
      <main className="main" inert={overlayActive} aria-hidden={overlayActive ? "true" : undefined}>
        <Topbar />
        <ContentRouter />
      </main>
    </div>
  );
}
