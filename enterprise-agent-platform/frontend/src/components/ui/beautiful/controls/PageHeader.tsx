/* PageHeader — the window header from the upstream harness (44px bar, hairline under it, 13px semibold title) with
 * header tabs styled as upstream ChatComposer's (6px chips on --field for the current tab). Inactive tabs use ink-2
 * instead of 50% ink so they keep 4.5:1. Starts with the narrow-screen navigation button. */
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../cn";
import { NavigationButton } from "./shell";

export type PageTab<K extends string = string> = { key: K; label: string; count?: number | string };

export function PageHeader<K extends string = string>({
  title,
  description,
  actions,
  tabs,
  activeTab,
  onTabChange,
  tabsLabel,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** buttons at the right of the title row */
  actions?: ReactNode;
  tabs?: readonly PageTab<K>[];
  activeTab?: K;
  onTabChange?: (key: K) => void;
  /** accessible name for the tab list (defaults to the title when it is text) */
  tabsLabel?: string;
  className?: string;
}) {
  const tabRefs = useRef(new Map<K, HTMLButtonElement>());
  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!tabs) return;
    const last = tabs.length - 1;
    const next =
      event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : -1;
    if (next < 0) return;
    event.preventDefault();
    const key = tabs[next].key;
    onTabChange?.(key);
    tabRefs.current.get(key)?.focus();
  };

  return (
    <header className={cn("shrink-0 border-b border-line", className)}>
      <div className="flex min-h-11 items-center gap-2 px-3 py-1.5 sm:pl-4">
        <NavigationButton />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[13px] font-semibold text-ink">{title}</h1>
          {description && <p className="mt-px text-[12.5px] leading-[1.45] text-ink-2">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
      {tabs && tabs.length > 0 && (
        <div
          role="tablist"
          aria-label={tabsLabel ?? (typeof title === "string" ? title : undefined)}
          className="-mt-0.5 flex items-center gap-0.5 overflow-x-auto px-2 pb-1.5 sm:px-2.5 [scrollbar-width:none]"
        >
          {tabs.map((tab, index) => {
            const selected = tab.key === activeTab;
            return (
              <button
                key={tab.key}
                ref={(node) => {
                  if (node) tabRefs.current.set(tab.key, node);
                  else tabRefs.current.delete(tab.key);
                }}
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected || (activeTab === undefined && index === 0) ? 0 : -1}
                onClick={() => onTabChange?.(tab.key)}
                onKeyDown={(event) => moveTab(event, index)}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-[6px] px-2 py-[3px] text-[13px] whitespace-nowrap transition-[background-color,color] duration-100 touch:min-h-11 touch:px-3",
                  selected ? "bg-field text-ink" : "text-ink-2 hover:text-ink",
                )}
              >
                {tab.label}
                {tab.count !== undefined && <span className="text-[11.5px] tabular-nums text-ink-2">{tab.count}</span>}
              </button>
            );
          })}
        </div>
      )}
    </header>
  );
}
