/* The upstream harness layout (components/site/IceCreamHarness.tsx): canvas ground with p-2.5, the SidebarNav rail
 * on the left, and the work area as a floating window (14px radius, hairline, page fill). Docked side windows
 * (<WindowAside>) portal into the same row. Below `lg` the sidebar becomes a modal drawer and the window goes
 * full-bleed. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ShellContext } from "../components/ui/beautiful/controls";
import { useModalFocus } from "../components/ui/beautiful/controls/overlay";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useWords } from "../words";

export const NARROW_QUERY = "(max-width: 1023px)";

export function AppFrame({
  renderSidebar,
  routeKey,
  children,
}: {
  renderSidebar: (variant: { drawer: boolean; onClose?: () => void }) => ReactNode;
  /** changes on navigation; closes the drawer */
  routeKey: string;
  children: ReactNode;
}) {
  const w = useWords();
  const narrow = useMediaQuery(NARROW_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [asideSlot, setAsideSlot] = useState<HTMLDivElement | null>(null);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => setDrawerOpen(false), [routeKey, narrow]);

  return (
    <ShellContext.Provider value={{ narrow, openNavigation: () => setDrawerOpen(true), asideSlot }}>
      <div className="flex h-[100dvh] bg-canvas text-ink lg:p-2.5 lg:pl-0">
        <button
          type="button"
          onClick={() => mainRef.current?.focus()}
          className="fixed top-2 left-2 z-[90] -translate-y-16 rounded-control bg-surface px-3 py-2 text-[13px] font-medium text-ink shadow-overlay focus:translate-y-0"
        >
          {w("Skip to content", "跳到主要内容", "跳到主要內容")}
        </button>
        {!narrow && renderSidebar({ drawer: false })}
        <div ref={setAsideSlot} className="flex min-h-0 min-w-0 flex-1 gap-2.5">
          <main
            ref={mainRef}
            tabIndex={-1}
            className="bui-window flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-page outline-none lg:rounded-window lg:border lg:border-line"
          >
            {children}
          </main>
        </div>
        {narrow && drawerOpen && <Drawer onClose={() => setDrawerOpen(false)}>{renderSidebar({ drawer: true, onClose: () => setDrawerOpen(false) })}</Drawer>}
      </div>
    </ShellContext.Provider>
  );
}

function Drawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const w = useWords();
  const panelRef = useRef<HTMLDivElement>(null);
  const onKeyDown = useModalFocus(true, panelRef, onClose);
  return (
    <div className="fixed inset-0 z-50">
      <div aria-hidden className="absolute inset-0 bg-scrim" style={{ animation: "fade-in 200ms ease-out both" }} onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={w("Navigation", "导航", "導覽")}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="bui-window absolute inset-y-0 left-0 flex w-[min(304px,86vw)] flex-col bg-canvas py-2.5 shadow-overlay outline-none"
        style={{ animation: "drawer-in 280ms cubic-bezier(0.23,1,0.32,1) both" }}
      >
        {children}
      </div>
    </div>
  );
}
