/* Overlay mechanics shared by Select, Menu, Dialog and Sheet: anchored fixed positioning (upstream WorkspaceMenu
 * places its portal at the trigger rect), outside-press dismissal, and the modal focus loop. */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";

const MARGIN = 8;

export type Side = "bottom" | "top" | "right";
export type Align = "start" | "end";

/** Fixed-position style that keeps a popup next to its anchor, flipping and clamping to the viewport. */
export function useAnchoredPosition({
  open,
  anchorRef,
  popupRef,
  side = "bottom",
  align = "start",
  offset = 6,
  matchWidth = false,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  popupRef: RefObject<HTMLElement | null>;
  side?: Side;
  align?: Align;
  offset?: number;
  matchWidth?: boolean;
}): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ position: "fixed", top: 0, left: 0, visibility: "hidden" });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = anchorRef.current;
      const popup = popupRef.current;
      if (!anchor || !popup) return;
      const rect = anchor.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const width = matchWidth ? Math.max(rect.width, popup.scrollWidth > rect.width ? Math.min(popup.scrollWidth, 360) : rect.width) : popup.offsetWidth;
      const height = popup.offsetHeight;
      let top: number;
      let left: number;
      let vertical: "top" | "bottom" = "top";
      if (side === "right") {
        left = rect.right + offset;
        if (left + width > viewportWidth - MARGIN) left = rect.left - offset - width;
        top = align === "end" ? rect.bottom - height : rect.top;
        vertical = align === "end" ? "bottom" : "top";
      } else {
        const below = rect.bottom + offset;
        const above = rect.top - offset - height;
        const fitsBelow = below + height <= viewportHeight - MARGIN;
        const fitsAbove = above >= MARGIN;
        const useBelow = side === "bottom" ? fitsBelow || !fitsAbove : !fitsAbove && fitsBelow;
        top = useBelow ? below : above;
        vertical = useBelow ? "top" : "bottom";
        left = align === "end" ? rect.right - width : rect.left;
      }
      left = Math.min(Math.max(left, MARGIN), Math.max(MARGIN, viewportWidth - MARGIN - width));
      top = Math.min(Math.max(top, MARGIN), Math.max(MARGIN, viewportHeight - MARGIN - height));
      setStyle({
        position: "fixed",
        top,
        left,
        width: matchWidth ? width : undefined,
        maxHeight: viewportHeight - MARGIN * 2,
        transformOrigin: `${vertical} ${align === "end" ? "right" : "left"}`,
      });
    };
    place();
    const observer = new ResizeObserver(place);
    if (popupRef.current) observer.observe(popupRef.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchorRef, popupRef, side, align, offset, matchWidth]);
  return style;
}

/** Close when a press lands outside every given element. */
export function useOutsidePress(open: boolean, refs: RefObject<HTMLElement | null>[], onOutside: () => void) {
  const latest = useRef(onOutside);
  latest.current = onOutside;
  useEffect(() => {
    if (!open) return;
    const press = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!refs.some((ref) => ref.current?.contains(target))) latest.current();
    };
    document.addEventListener("pointerdown", press);
    return () => document.removeEventListener("pointerdown", press);
    // `refs` are stable ref objects; only the open state re-arms the listener.
  }, [open]);
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => !element.closest("[inert],[hidden],[aria-hidden=true]"));
}

let scrollLocks = 0;

/** Modal behavior for Dialog/Sheet/drawer: focus moves in (initial element, else `[data-autofocus]`, else first
 * focusable, else the panel), Tab cycles inside, Escape closes, focus returns to the opener, page scroll is locked
 * while open. Spread the returned `onKeyDown` on the panel. */
export function useModalFocus(open: boolean, panelRef: RefObject<HTMLElement | null>, onClose: () => void, initialFocusRef?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const candidates = panel ? focusables(panel) : [];
    // The header close control is the fallback, not the first stop: content and actions come first.
    const target = initialFocusRef?.current ?? panel?.querySelector<HTMLElement>("[data-autofocus]") ?? candidates.find((element) => !element.hasAttribute("data-modal-close")) ?? candidates[0] ?? panel;
    target?.focus({ preventScroll: true });
    scrollLocks += 1;
    document.body.style.overflow = "hidden";
    return () => {
      scrollLocks -= 1;
      if (scrollLocks === 0) document.body.style.overflow = "";
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
    // Runs once per opening: focus moves in on open and back to the opener on close.
  }, [open]);

  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !panelRef.current) return;
    const items = focusables(panelRef.current);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
}
