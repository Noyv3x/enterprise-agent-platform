import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";
import { cx } from "../../lib/cx";
import { Icon } from "./Icon";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

let openModalCount = 0;
let rootWasInert = false;
let savedBodyOverflow = "";
const modalStack: string[] = [];

function lockApplication() {
  const appRoot = document.getElementById("react-root");
  if (openModalCount === 0) {
    rootWasInert = appRoot?.hasAttribute("inert") ?? false;
    savedBodyOverflow = document.body.style.overflow;
    appRoot?.setAttribute("inert", "");
    document.body.style.overflow = "hidden";
  }
  openModalCount += 1;
}

function unlockApplication() {
  openModalCount = Math.max(0, openModalCount - 1);
  if (openModalCount !== 0) return;
  const appRoot = document.getElementById("react-root");
  if (!rootWasInert) appRoot?.removeAttribute("inert");
  document.body.style.overflow = savedBodyOverflow;
}

function syncModalStack() {
  const topId = modalStack[modalStack.length - 1];
  document.querySelectorAll<HTMLElement>(".modal[data-modal-id]").forEach((modal) => {
    const isTop = modal.dataset.modalId === topId;
    if (isTop) {
      modal.removeAttribute("inert");
      modal.removeAttribute("aria-hidden");
    } else {
      modal.setAttribute("inert", "");
      modal.setAttribute("aria-hidden", "true");
    }
  });
}

function pushModal(id: string) {
  modalStack.push(id);
  syncModalStack();
}

function removeModal(id: string) {
  const index = modalStack.lastIndexOf(id);
  if (index >= 0) modalStack.splice(index, 1);
  syncModalStack();
}

function isTopModal(id: string) {
  return modalStack[modalStack.length - 1] === id;
}

export interface DialogProps {
  id?: string;
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  closeOnBackdrop?: boolean;
  showCloseButton?: boolean;
  /** Focus this element after the panel opens. Falls back to the first control. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}

interface DialogFrameProps extends DialogProps {
  variant?: "dialog" | "drawer";
}

/**
 * Accessible modal frame shared by centered dialogs and right-side drawers.
 * It is portaled outside #react-root so the application can be made inert while open.
 */
export function Dialog({
  id,
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
  closeOnBackdrop = true,
  showCloseButton = true,
  initialFocusRef,
  variant = "dialog",
}: DialogFrameProps) {
  const { t } = useI18n();
  const titleId = useId();
  const descriptionId = useId();
  const modalId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    lockApplication();
    pushModal(modalId);

    const focusTarget =
      initialFocusRef?.current ?? panelRef.current?.querySelector<HTMLElement>(FOCUSABLE) ?? panelRef.current;
    focusTarget?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopModal(modalId)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;
      const controls = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true",
      );
      if (!controls.length) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      removeModal(modalId);
      unlockApplication();
      opener?.focus();
    };
  }, [initialFocusRef, modalId, open]);

  if (!open) return null;

  return createPortal(
    <div
      className={cx("modal", variant === "drawer" && "modal--drawer")}
      data-modal-id={modalId}
      onMouseDown={(event) => {
        if (closeOnBackdrop && isTopModal(modalId) && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        id={id}
        ref={panelRef}
        className={cx("modal__panel", className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <header className="modal__header">
          <div className="modal__heading">
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          {showCloseButton ? (
            <button
              className="icon-btn modal__close"
              type="button"
              aria-label={t("common.close")}
              title={t("common.close")}
              onClick={onClose}
            >
              <Icon name="close" />
            </button>
          ) : null}
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
