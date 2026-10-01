/* Dialog and ConfirmDialog — upstream UseThisHarness modal: scrim with 2px blur, window-radius surface with overlay
 * shadow, 16px semibold title, 13px description, 32px close control, pop-in. Adds the modal focus loop, Escape and
 * a destructive confirmation. */
import { useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Button } from "../atoms/Button";
import { useWords } from "../../../../words";
import { cn } from "../cn";
import { Icon } from "./Icon";
import { Notice } from "./Notice";
import { useModalFocus } from "./overlay";

export function Dialog({
  open,
  onClose,
  title,
  description,
  footer,
  initialFocusRef,
  size = "md",
  role = "dialog",
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  /** actions row; Cancel first, primary last */
  footer?: ReactNode;
  /** element focused on open (default: first focusable) */
  initialFocusRef?: RefObject<HTMLElement | null>;
  size?: "sm" | "md" | "lg";
  role?: "dialog" | "alertdialog";
  children?: ReactNode;
}) {
  if (!open) return null;
  return (
    <DialogPanel onClose={onClose} title={title} description={description} footer={footer} initialFocusRef={initialFocusRef} size={size} role={role}>
      {children}
    </DialogPanel>
  );
}

const WIDTH = { sm: "max-w-[400px]", md: "max-w-[520px]", lg: "max-w-[720px]" } as const;

function DialogPanel({
  onClose,
  title,
  description,
  footer,
  initialFocusRef,
  size,
  role,
  children,
}: {
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  size: keyof typeof WIDTH;
  role: "dialog" | "alertdialog";
  children?: ReactNode;
}) {
  const w = useWords();
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onKeyDown = useModalFocus(true, panelRef, onClose, initialFocusRef);
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 sm:p-8">
      <div
        aria-hidden
        className="absolute inset-0 bg-scrim backdrop-blur-[2px]"
        style={{ animation: "fade-in 200ms ease-out both" }}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cn("bui-window relative flex max-h-[85vh] w-full flex-col overflow-hidden rounded-window bg-surface shadow-overlay outline-none", WIDTH[size])}
        style={{ animation: "pop-in 250ms cubic-bezier(0.23,1,0.32,1) both" }}
      >
        <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[16px] font-semibold tracking-[-0.01em] text-ink">{title}</h2>
            {description && <p id={descriptionId} className="mt-2 text-[13px] leading-relaxed text-pretty text-ink-2">{description}</p>}
          </div>
          <button
            type="button"
            data-modal-close
            aria-label={w("Close", "关闭", "關閉")}
            onClick={onClose}
            className="-mt-1 -mr-1 flex size-8 shrink-0 items-center justify-center rounded-control text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink touch:size-11"
          >
            <Icon name="close" size={15} strokeWidth={2.2} />
          </button>
        </div>
        {children && <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">{children}</div>}
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Confirmation for an irreversible or consequential action. `tone="danger"` paints the confirm button red and
 * focuses Cancel first. While `busy`, both actions are disabled; `error` shows the server's reason inline. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = "default",
  busy = false,
  error,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  busy?: boolean;
  error?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  const w = useWords();
  const danger = tone === "danger";
  return (
    <Dialog
      open={open}
      onClose={() => !busy && onCancel()}
      title={title}
      description={description}
      size="sm"
      role="alertdialog"
      footer={
        <>
          <Button type="button" data-autofocus={danger || undefined} size="sm" variant="secondary" disabled={busy} onClick={onCancel} className="touch:h-11 touch:px-4">
            {cancelLabel ?? w("Cancel", "取消", "取消")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="primary"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={onConfirm}
            className={cn("touch:h-11 touch:px-4", danger && "bg-danger text-white hover:opacity-90 dark:bg-danger dark:text-white")}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {(children || error) && (
        <div className="flex flex-col gap-3">
          {children}
          {error && <Notice tone="danger" title={error} />}
        </div>
      )}
    </Dialog>
  );
}
