import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { PortalContext, useBeautifulContainer } from "./Root";
import { Button } from "./Controls";
import { Glyph } from "./Glyph";
import { useUnmountFocusRestore } from "../../common/useUnmountFocusRestore";

// Native inert complements Base UI focus/escape ownership, including sibling
// confirmations. Nested controls portal inside their owning overlay host.
const inertOwners = new Map<HTMLElement, { count: number; previous: boolean }>();
function acquireInert(element: HTMLElement) {
  const entry = inertOwners.get(element);
  if (entry) entry.count++;
  else { inertOwners.set(element, { count: 1, previous: element.inert }); element.inert = true; }
  return () => {
    const current = inertOwners.get(element);
    if (!current) return;
    if (--current.count === 0) { element.inert = current.previous; inertOwners.delete(element); }
  };
}
export interface OverlayProps {
  id?: string; open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode;
  children: ReactNode; footer?: ReactNode; className?: string; closeOnBackdrop?: boolean; label?: string;
  showCloseButton?: boolean; closeLabel: string; afterOpenChange?: (open: boolean) => void;
  initialFocusRef?: RefObject<HTMLElement | null>; placement?: "center" | "right" | "left"; wide?: boolean;
}
export function Overlay({ id, open, onClose, title, description, children, footer, className = "", closeOnBackdrop = true, showCloseButton = true, closeLabel, afterOpenChange, initialFocusRef, placement = "center", wide, label }: OverlayProps) {
  const container = useBeautifulContainer();
  const portal = useRef<HTMLDivElement>(null);
  const [portalNode, setPortalNode] = useState<HTMLDivElement | null>(null);
  const mountPortal = useCallback((node: HTMLDivElement | null) => { portal.current = node; setPortalNode(node); }, []);
  const content = useUnmountFocusRestore(open);
  useLayoutEffect(() => {
    if (!open || !portalNode) return;
    const releases: (() => void)[] = [];
    let child: HTMLElement = portalNode;
    while (child.parentElement) {
      const parent = child.parentElement;
      for (const sibling of parent.children) {
        if (sibling !== child && sibling instanceof HTMLElement && !sibling.hasAttribute("data-bui-toast-layer")) releases.push(acquireInert(sibling));
      }
      if (parent === document.body) break;
      child = parent;
    }
    return () => { for (const release of releases) release(); };
  }, [open, portalNode]);
  return (
    <BaseDialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }} onOpenChangeComplete={afterOpenChange} disablePointerDismissal={!closeOnBackdrop}>
      <BaseDialog.Portal container={container} ref={mountPortal} className="bui-overlay-portal">
        <PortalContext.Provider value={portal}>
          <BaseDialog.Backdrop className="bui-backdrop" />
          <div className={`bui-overlay-positioner bui-overlay-positioner--${placement}`}>
            <BaseDialog.Popup id={id} ref={content} initialFocus={initialFocusRef} finalFocus={false} {...(label ? { "aria-label": label, "aria-labelledby": undefined } : {})} className={`bui-overlay${wide ? " bui-overlay--wide" : ""} ${className}`}>
              <header className="bui-overlay-header">
                <div><BaseDialog.Title className="bui-overlay-title">{title}</BaseDialog.Title>{description && <BaseDialog.Description render={<div />} className="bui-overlay-description">{description}</BaseDialog.Description>}</div>
                {showCloseButton && <BaseDialog.Close render={<Button variant="quiet" size="sm" aria-label={closeLabel} icon={<Glyph name="close" size={16} />} />} />}
              </header>
              <div className="bui-overlay-body">{children}</div>
              {footer && <footer className="bui-overlay-footer">{footer}</footer>}
            </BaseDialog.Popup>
          </div>
        </PortalContext.Provider>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
