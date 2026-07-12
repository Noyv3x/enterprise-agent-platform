/* <ConfirmDialog/> — a focus-trapped, promise-friendly replacement for the
   blocking window.confirm() the legacy admin deletes used. Built here so the
   parallel admin phases (4c/4d) share one dialog via useConfirm().

   Behavior contract:
   - keeps the exact prompt string the caller passes (legacy passed it to
     window.confirm),
   - cancel is a no-op (resolves false; the destructive action does not run),
   - focus is trapped while open and restored to the opener on close,
   - Escape cancels; clicking the backdrop cancels.

   No new stylesheet is introduced in this phase (CSS refresh is later): the
   panel reuses the global .card / .btn class contract and only the overlay
   geometry is inline. Tokens (--overlay) are referenced via CSS vars. */

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";
import { cx } from "../../lib/cx";

export interface ConfirmDialogProps {
  message: string;
  title?: string;
  confirmText?: string;
  cancelText?: string;
  /** style the confirm button as destructive (admin deletes). */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  background: "var(--overlay)",
  zIndex: 100,
};

const dialogStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 420,
  display: "grid",
  gap: 14,
};

export function ConfirmDialog({
  message,
  title,
  confirmText,
  cancelText,
  danger,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
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
      previouslyFocused?.focus?.();
    };
  }, []);

  return createPortal(
    <div
      style={overlayStyle}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={panelRef}
        className="card"
        role="dialog"
        aria-modal="true"
        aria-label={title || t("chat.confirm.label")}
        style={dialogStyle}
      >
        {title ? (
          <div className="card__title">
            <span>{title}</span>
          </div>
        ) : null}
        <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{message}</p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn btn--sm" type="button" onClick={onCancel}>
            {cancelText ?? t("chat.confirm.cancel")}
          </button>
          <button
            className={cx("btn", "btn--sm", danger ? "btn--danger" : "btn--primary")}
            type="button"
            onClick={onConfirm}
          >
            {confirmText ?? t("chat.confirm.confirm")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
