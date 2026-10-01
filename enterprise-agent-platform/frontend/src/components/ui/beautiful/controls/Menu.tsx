/* Action menu — upstream SidebarNav WorkspaceMenu (portal at the trigger rect, 14px overlay surface, GlideMenu rows
 * 36px with 20px icon slot, hairline separators). Adds menu semantics: arrows/Home/End move focus, typing jumps,
 * Escape closes and returns focus to the trigger, Tab closes. */
import { useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import GlideMenu from "../primitives/GlideMenu";
import { cn } from "../cn";
import { Icon } from "./Icon";
import { useAnchoredPosition, useOutsidePress, type Align, type Side } from "./overlay";

export type MenuItem =
  | {
      key: string;
      label: string;
      icon?: ReactNode;
      /** trailing text such as the current value */
      detail?: string;
      /** renders a check and menuitemradio semantics */
      checked?: boolean;
      tone?: "default" | "danger";
      disabled?: boolean;
      onSelect: () => void;
    }
  | { key: string; separator: true }
  | { key: string; heading: ReactNode };

export interface MenuTriggerProps {
  ref: RefObject<HTMLButtonElement | null>;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

const ROW = "[role^=menuitem]:not([aria-disabled=true])";

export function Menu({
  label,
  items,
  side = "bottom",
  align = "start",
  width = 256,
  trigger,
}: {
  /** accessible name of the menu */
  label: string;
  items: MenuItem[];
  side?: Side;
  align?: Align;
  width?: number;
  /** render the trigger button and spread the given props on it */
  trigger: (props: MenuTriggerProps) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const style = useAnchoredPosition({ open, anchorRef: triggerRef, popupRef, side, align });
  useOutsidePress(open, [triggerRef, popupRef], () => setOpen(false));

  const rows = () => [...(popupRef.current?.querySelectorAll<HTMLElement>(ROW) ?? [])];
  const focusRow = (pick: (list: HTMLElement[], index: number) => number) => {
    const list = rows();
    if (list.length === 0) return;
    const index = list.indexOf(document.activeElement as HTMLElement);
    list[(pick(list, index) + list.length) % list.length]?.focus();
  };
  const close = (restore: boolean) => {
    setOpen(false);
    if (restore) triggerRef.current?.focus();
  };
  const openWith = (first: boolean) => {
    setOpen(true);
    requestAnimationFrame(() => focusRow((list) => (first ? 0 : list.length - 1)));
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const { key } = event;
    if (key === "ArrowDown") focusRow((_, index) => index + 1);
    else if (key === "ArrowUp") focusRow((list, index) => (index < 0 ? list.length - 1 : index - 1));
    else if (key === "Home") focusRow(() => 0);
    else if (key === "End") focusRow((list) => list.length - 1);
    else if (key === "Escape") {
      event.stopPropagation();
      close(true);
    } else if (key === "Tab") {
      event.preventDefault();
      close(true);
    } else if (key.length === 1 && /\S/.test(key)) {
      focusRow((list, index) => {
        for (let offset = 1; offset <= list.length; offset += 1) {
          const candidate = (index + offset) % list.length;
          if (list[candidate].textContent?.trim().toLowerCase().startsWith(key.toLowerCase())) return candidate;
        }
        return index;
      });
    } else return;
    event.preventDefault();
  };

  return (
    <>
      {trigger({
        ref: triggerRef,
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": open ? menuId : undefined,
        onClick: () => (open ? close(false) : openWith(true)),
        onKeyDown: (event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openWith(event.key === "ArrowDown");
          }
        },
      })}
      {open &&
        createPortal(
          <div
            ref={popupRef}
            id={menuId}
            role="menu"
            aria-label={label}
            onKeyDown={onMenuKeyDown}
            className="bui-popover z-[80] overflow-y-auto rounded-[14px] bg-surface p-1.5 shadow-overlay"
            style={{ ...style, width, animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both" }}
          >
            <GlideMenu className="flex flex-col gap-px" highlightClassName="inset-x-0 rounded-[8px] bg-hover-2" rowSelector={ROW}>
              {items.map((item) => {
                if ("separator" in item) return <div key={item.key} role="separator" className="my-1 h-px bg-line" />;
                if ("heading" in item) return <div key={item.key} className="px-2 pt-1 pb-1.5">{item.heading}</div>;
                const danger = item.tone === "danger";
                return (
                  <button
                    key={item.key}
                    type="button"
                    role={item.checked === undefined ? "menuitem" : "menuitemradio"}
                    aria-checked={item.checked}
                    aria-disabled={item.disabled || undefined}
                    tabIndex={-1}
                    onClick={() => {
                      if (item.disabled) return;
                      close(true);
                      item.onSelect();
                    }}
                    className={cn(
                      "relative z-10 flex h-9 w-full items-center gap-1.5 rounded-[8px] px-2 text-left outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--accent)] touch:h-11",
                      item.disabled && "cursor-not-allowed opacity-50",
                    )}
                  >
                    {item.icon && <span className={cn("flex size-5 shrink-0 items-center justify-center", danger ? "text-red" : "text-ink-2")}>{item.icon}</span>}
                    <span className={cn("min-w-0 flex-1 truncate text-[13.5px]", danger ? "text-red-ink" : "text-ink")}>{item.label}</span>
                    {item.detail && <span className="shrink-0 text-[12px] text-ink-2">{item.detail}</span>}
                    {item.checked && <span className="shrink-0 text-ink"><Icon name="check" size={16} strokeWidth={2.2} /></span>}
                  </button>
                );
              })}
            </GlideMenu>
          </div>,
          document.body,
        )}
    </>
  );
}
