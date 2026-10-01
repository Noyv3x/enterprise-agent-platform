/* Shell hooks for views: the narrow-screen drawer trigger and the docked side window. The app shell (src/shell)
 * provides the context; views rendered without it (tests, previews) get a wide, drawer-less default. */
import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useWords } from "../../../../words";
import { cn } from "../cn";
import { Icon } from "./Icon";

export interface ShellContextValue {
  /** below the `lg` breakpoint: the sidebar is a drawer and the window is full-bleed */
  narrow: boolean;
  openNavigation: () => void;
  /** row slot next to the main window, for <WindowAside> */
  asideSlot: HTMLElement | null;
}

export const ShellContext = createContext<ShellContextValue>({ narrow: false, openNavigation: () => undefined, asideSlot: null });

export function useShell(): ShellContextValue {
  return useContext(ShellContext);
}

/** Opens the navigation drawer; renders only on narrow screens. Put it first in a custom window header
 * (PageHeader already does). */
export function NavigationButton({ className }: { className?: string }) {
  const w = useWords();
  const { narrow, openNavigation } = useShell();
  if (!narrow) return null;
  return (
    <button
      type="button"
      aria-label={w("Open navigation", "打开导航", "開啟導覽")}
      onClick={openNavigation}
      className={cn("-ml-1.5 flex size-11 shrink-0 items-center justify-center rounded-control text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink", className)}
    >
      <Icon name="menu" size={18} />
    </button>
  );
}

/** A second window docked right of the main one (harness artifact pane: 14px radius, hairline, page fill).
 * Hidden on narrow screens — use <Sheet> there. */
export function WindowAside({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  const { narrow, asideSlot } = useShell();
  if (narrow || !asideSlot) return null;
  return createPortal(
    <aside
      aria-label={label}
      className={cn("bui-window flex w-[360px] min-w-0 shrink-0 flex-col overflow-hidden rounded-window border border-line bg-page", className)}
      style={{ animation: "fade-in 300ms ease both" }}
    >
      {children}
    </aside>,
    asideSlot,
  );
}
