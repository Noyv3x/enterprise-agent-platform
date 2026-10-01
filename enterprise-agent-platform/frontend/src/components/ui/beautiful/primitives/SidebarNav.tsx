/* Beautiful UI — components/primitives/SidebarNav.tsx (MIT, see ../LICENSE and ../NOTICE).
 * Adapted:
 * - demo workspace, nav and recents replaced by props: brand (logo + product name), primary nav, any number of
 *   list sections (channels, chats) with active row, optional chat search and per-row actions, footer nav and an
 *   account slot; the workspace switcher menu becomes the static brand row (the account menu lives in the footer);
 * - the "Upgrade" footer CTA becomes the footer nav (Admin, Settings) plus the account row, kept on the rail;
 * - collapse is controlled (the shell persists it); a `drawer` variant fills a narrow-screen panel and swaps the
 *   collapse control for a close control;
 * - section headers toggle their list (aria-expanded); when collapsed with a searchable section, a rail search
 *   button stands in for the hidden chat search;
 * - Central Icons replaced by open line icons; i18n labels; aria-current on the active row; ink-2 text for 4.5:1;
 *   44px rows on touch.
 * Motion (52↔224px, copy fade/slide, 180ms chat-search grow) is upstream's. Styles: ./sidebar-nav.css. */
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode, type Ref } from "react";
import GlideMenu from "./GlideMenu";
import { matchesQuery } from "./SearchList";
import { Icon } from "../controls/Icon";
import "./sidebar-nav.css";

export type SidebarNavItem = { key: string; label: string; icon: ReactNode; count?: string };
export type SidebarRecent = { id: string; label: string };

export type SidebarSearchLabels = {
  open: string;
  placeholder: string;
  ariaLabel: string;
  close: string;
  empty: string;
};

export type SidebarSection = {
  key: string;
  label: string;
  items: SidebarRecent[];
  activeId?: string | null;
  onPick: (id: string) => void;
  /** adds the upstream chat search to the section header */
  search?: SidebarSearchLabels;
  /** shown when the section has no rows at all */
  emptyLabel?: string;
  /** trailing control for a row (revealed on hover/focus; always on touch) */
  rowActions?: (item: SidebarRecent) => ReactNode;
};

export type SidebarNavLabels = {
  navigation: string;
  collapse: string;
  expand: string;
  close: string;
};

const SIDEBAR_MOTION = {
  expandedWidth: 224,
  collapsedWidth: 52,
  duration: 280,
  copyDuration: 180,
  copyOffset: 8,
  easing: "cubic-bezier(0.16, 1, 0.3, 1)",
};

/* ─────────────────────────────────────────────────────────
 * CHAT SEARCH STORYBOARD
 *
 *   0ms   search is triggered; Chats label begins fading
 *   0ms   field grows right → left from the search control
 * 180ms   field fills the row; cursor is focused and ready
 * ───────────────────────────────────────────────────────── */
const CHAT_SEARCH_MOTION = {
  duration: 180,
  closedWidth: 28,
  easing: "cubic-bezier(0.16, 1, 0.3, 1)",
};

function GlideGroup({ children }: { children: ReactNode }) {
  return (
    <GlideMenu
      rowSelector="[data-row]"
      highlightClassName="sidebar-glide-highlight rounded-[7px] bg-hover-2"
      className="group/glide flex flex-col gap-px"
    >
      {children}
    </GlideMenu>
  );
}

/** A rail row: icon at x=26 in both states, label fading out when collapsed. Extra button props pass through
 * (the account row spreads its menu-trigger props here). */
export function RailButton({
  icon,
  label,
  active = false,
  count,
  trailing,
  className = "",
  ref,
  ...props
}: {
  icon: ReactNode;
  label: ReactNode;
  active?: boolean;
  count?: string;
  trailing?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      ref={ref}
      data-row
      type="button"
      aria-current={active ? "page" : undefined}
      {...props}
      className={`sidebar-row relative z-10 mx-2 flex h-8 items-center rounded-[8px] px-2 text-left
        transition-[width,background-color,color,transform] duration-150 active:scale-[0.98] touch:h-11
        ${active ? "bg-hover-2 group-hover/glide:bg-transparent" : ""} ${className}`}
    >
      <span className={`flex size-5 shrink-0 items-center justify-center ${active ? "text-ink" : "text-ink-2"}`}>
        {icon}
      </span>
      <span className={`sidebar-copy ml-1.5 min-w-0 flex-1 truncate text-[14px] font-medium ${active ? "text-ink" : "text-ink-2"}`}>
        {label}
      </span>
      {count && (
        <span className="sidebar-copy mr-2 shrink-0 text-[12px] font-medium tabular-nums text-ink-2">
          {count}
        </span>
      )}
      {trailing && <span className="sidebar-copy ml-1 flex shrink-0 text-ink-2">{trailing}</span>}
    </button>
  );
}

function SectionList({ section }: { section: SidebarSection }) {
  const [expanded, setExpanded] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = `sidebar-section-${section.key}`;
  const visible = section.items.filter((item) => matchesQuery(item.label, query));
  const search = section.search;

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
  };

  return (
    <div className="mb-3">
      <div className="sidebar-copy relative mx-2 mb-1 h-8 touch:h-11">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-hidden={searchOpen}
          tabIndex={searchOpen ? -1 : 0}
          onClick={() => setExpanded((current) => !current)}
          className={`absolute inset-y-0 left-0 flex items-center gap-1.5 rounded-[8px] px-2 text-[12.5px] font-medium text-ink-2 transition-[opacity,transform,color] hover:text-ink ${search ? "right-9" : "right-0"} ${searchOpen ? "pointer-events-none -translate-x-1 opacity-0" : "translate-x-0 opacity-100"}`}
          style={{ transitionDuration: `${CHAT_SEARCH_MOTION.duration}ms`, transitionTimingFunction: CHAT_SEARCH_MOTION.easing }}
        >
          <Icon name="chevronDown" size={14} strokeWidth={2.2} className={`transition-transform duration-150 ${expanded ? "" : "-rotate-90"}`} />
          <span className="truncate">{section.label}</span>
        </button>

        {search && (
          <>
            <button
              type="button"
              aria-label={search.open}
              aria-expanded={searchOpen}
              tabIndex={searchOpen ? -1 : 0}
              onClick={() => {
                setExpanded(true);
                setSearchOpen(true);
              }}
              className={`absolute top-0 right-0 z-10 flex size-8 items-center justify-center rounded-[8px] text-ink-2 transition-[opacity,background-color,color,transform] hover:bg-hover-2 hover:text-ink active:scale-[0.96] touch:size-11 ${searchOpen ? "pointer-events-none opacity-0" : "opacity-100"}`}
              style={{ transitionDuration: `${CHAT_SEARCH_MOTION.duration}ms` }}
            >
              <Icon name="search" size={16} />
            </button>

            <div
              className={`absolute top-0 right-0 z-20 flex h-8 items-center overflow-hidden rounded-[8px] bg-field text-ink-2 shadow-hairline transition-[width,opacity] focus-within:text-ink touch:h-11 ${searchOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
              style={{
                width: searchOpen ? "100%" : CHAT_SEARCH_MOTION.closedWidth,
                transitionDuration: `${CHAT_SEARCH_MOTION.duration}ms`,
                transitionTimingFunction: CHAT_SEARCH_MOTION.easing,
              }}
            >
              <span className="ml-2 flex shrink-0 items-center justify-center">
                <Icon name="search" size={15} />
              </span>
              <input
                ref={searchRef}
                value={query}
                tabIndex={searchOpen ? 0 : -1}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    closeSearch();
                  }
                }}
                placeholder={search.placeholder}
                aria-label={search.ariaLabel}
                className="ml-1.5 min-w-0 flex-1 bg-transparent text-[13px] font-medium text-ink outline-none placeholder:text-ink-2 touch:text-[16px]"
              />
              <button
                type="button"
                aria-label={search.close}
                tabIndex={searchOpen ? 0 : -1}
                onClick={closeSearch}
                className="flex size-8 shrink-0 items-center justify-center rounded-[8px] text-ink-2 transition-[background-color,color,transform] duration-150 hover:bg-hover-2 hover:text-ink active:scale-[0.96] touch:size-11"
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          </>
        )}
      </div>

      <div id={listId} hidden={!expanded}>
        <GlideGroup>
          {visible.map((item) => {
            const active = item.id === section.activeId;
            return (
              <div
                key={item.id}
                data-row
                className={`sidebar-row group/row relative z-10 mx-2 flex h-8 items-center rounded-[8px] transition-[width,background-color,color,transform] duration-150 touch:h-11 ${
                  active ? "bg-hover-2 group-hover/glide:bg-transparent" : ""
                }`}
              >
                <button
                  type="button"
                  title={item.label}
                  data-row-id={item.id}
                  aria-current={active ? "page" : undefined}
                  onClick={() => section.onPick(item.id)}
                  className={`sidebar-copy flex h-full min-w-0 flex-1 items-center rounded-[8px] px-2 text-left text-[14px] font-medium ${active ? "text-ink" : "text-ink-2"}`}
                >
                  <span className="min-w-0 truncate">{item.label}</span>
                </button>
                {section.rowActions && (
                  // .sidebar-copy (unlayered, like upstream) owns opacity for the collapse fade; the hover reveal
                  // sits on an inner element so the two never compete.
                  <div className="sidebar-copy flex shrink-0 items-center pr-0.5">
                    <div className="flex opacity-0 transition-opacity duration-100 group-focus-within/row:opacity-100 group-hover/row:opacity-100 has-[[aria-expanded=true]]:opacity-100 touch:opacity-100">
                      {section.rowActions(item)}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {query && visible.length === 0 && search && (
            <div className="sidebar-copy mx-2 px-2 py-2 text-[12.5px] text-ink-2">{search.empty}</div>
          )}
          {!query && section.items.length === 0 && section.emptyLabel && (
            <div className="sidebar-copy mx-2 px-2 py-2 text-[12.5px] text-ink-2">{section.emptyLabel}</div>
          )}
        </GlideGroup>
      </div>
    </div>
  );
}

export default function SidebarNav({
  brand,
  labels,
  collapsed,
  onCollapsedChange,
  drawer = false,
  onClose,
  className = "",
  newChat,
  nav,
  activeNav,
  onNavigate,
  sections = [],
  railSearch,
  footerNav = [],
  account,
}: {
  brand: { name: string; logo: ReactNode };
  labels: SidebarNavLabels;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  /** narrow-screen panel: always expanded, fills its container, close instead of collapse */
  drawer?: boolean;
  onClose?: () => void;
  className?: string;
  newChat?: { label: string; onClick: () => void };
  nav: SidebarNavItem[];
  activeNav?: string;
  onNavigate: (key: string) => void;
  sections?: SidebarSection[];
  /** rail-only control (collapsed state) standing in for the hidden section search */
  railSearch?: ReactNode;
  footerNav?: SidebarNavItem[];
  /** the account row, usually a <RailButton> menu trigger */
  account?: ReactNode;
}) {
  const isCollapsed = !drawer && collapsed;
  return (
    <aside
      data-sidebar-collapsed={isCollapsed}
      data-sidebar-drawer={drawer}
      aria-label={labels.navigation}
      className={`relative flex h-full shrink-0 overflow-hidden transition-[width] ${className}`}
      style={{
        width: drawer ? "100%" : isCollapsed ? SIDEBAR_MOTION.collapsedWidth : SIDEBAR_MOTION.expandedWidth,
        transitionDuration: `${SIDEBAR_MOTION.duration}ms`,
        transitionTimingFunction: SIDEBAR_MOTION.easing,
        "--sidebar-copy-duration": `${SIDEBAR_MOTION.copyDuration}ms`,
        "--sidebar-copy-offset": `${SIDEBAR_MOTION.copyOffset}px`,
        "--sidebar-easing": SIDEBAR_MOTION.easing,
      } as CSSProperties}
    >
      <div className={`flex min-h-0 shrink-0 flex-col ${drawer ? "w-full" : "w-[224px]"}`}>
        <div className="relative mb-2.5 h-10 shrink-0 touch:h-12">
          <div
            aria-hidden={isCollapsed}
            className={`sidebar-workspace-control absolute top-1 left-2 flex h-8 items-center rounded-[8px] px-2 text-left touch:h-11 ${drawer ? "right-14" : "w-[164px]"}`}
          >
            <span className="sidebar-logo flex size-5 shrink-0 items-center justify-center text-ink">{brand.logo}</span>
            <span className="sidebar-copy ml-1.5 min-w-0 flex-1 truncate text-[14px] font-medium text-ink-2">{brand.name}</span>
          </div>

          {drawer ? (
            <button
              type="button"
              aria-label={labels.close}
              onClick={onClose}
              className="absolute top-0.5 right-2 flex size-11 items-center justify-center rounded-[8px] text-ink-2 transition-[background-color,color] duration-150 hover:bg-hover-2 hover:text-ink"
            >
              <Icon name="close" size={18} />
            </button>
          ) : (
            <>
              <button
                type="button"
                aria-label={labels.collapse}
                aria-hidden={isCollapsed}
                tabIndex={isCollapsed ? -1 : 0}
                onClick={() => onCollapsedChange(true)}
                className="sidebar-collapse-control absolute top-1 right-2 flex size-8 items-center justify-center rounded-[8px] text-ink-2 transition-[opacity,background-color,color] duration-150 hover:bg-hover-2 hover:text-ink touch:top-0.5 touch:size-11"
              >
                <Icon name="sidebar" size={18} />
              </button>
              <button
                type="button"
                aria-label={labels.expand}
                aria-hidden={!isCollapsed}
                tabIndex={isCollapsed ? 0 : -1}
                onClick={() => onCollapsedChange(false)}
                className="sidebar-expand-control absolute top-0.5 left-2 flex size-9 items-center justify-center rounded-[8px] text-ink-2 transition-[opacity,background-color,color] duration-150 hover:bg-hover-2 hover:text-ink touch:size-11"
              >
                <Icon name="sidebar" size={18} className="rotate-180" />
              </button>
            </>
          )}
        </div>

        <GlideGroup>
          {newChat && <RailButton data-sidebar-new-chat icon={<Icon name="compose" size={18} />} label={newChat.label} title={isCollapsed ? newChat.label : undefined} onClick={newChat.onClick} />}
          {nav.map((item) => (
            <RailButton
              key={item.key}
              icon={item.icon}
              label={item.label}
              count={item.count}
              active={activeNav === item.key}
              title={isCollapsed ? item.label : undefined}
              onClick={() => onNavigate(item.key)}
            />
          ))}
          {isCollapsed && railSearch}
        </GlideGroup>

        <div className="sidebar-copy mt-3 min-h-0 flex-1 overflow-x-hidden overflow-y-auto" inert={isCollapsed || undefined}>
          {sections.map((section) => (
            <SectionList key={section.key} section={section} />
          ))}
        </div>

        {(footerNav.length > 0 || account) && (
          <div className="mx-2 mt-2 border-t border-line pt-2">
            <div className="-mx-2">
              <GlideGroup>
                {footerNav.map((item) => (
                  <RailButton
                    key={item.key}
                    icon={item.icon}
                    label={item.label}
                    active={activeNav === item.key}
                    title={isCollapsed ? item.label : undefined}
                    onClick={() => onNavigate(item.key)}
                  />
                ))}
                {account}
              </GlideGroup>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
