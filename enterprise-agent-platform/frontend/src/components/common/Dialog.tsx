import { Modal } from "antd";
import { useEffect, type ReactNode, type RefObject } from "react";
import { useI18n } from "../../i18n";
import { cx } from "../../lib/cx";
import { useFieldworkContainer } from "../ui/fieldwork";
import { useUnmountFocusRestore } from "./useUnmountFocusRestore";

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
  afterOpenChange?: (open: boolean) => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export function Dialog({ id, open, onClose, title, description, children, footer, className,
  closeOnBackdrop = true, showCloseButton = true, afterOpenChange, initialFocusRef }: DialogProps) {
  const { t } = useI18n();
  const getContainer = useFieldworkContainer();
  const contentRef = useUnmountFocusRestore(open);

  useEffect(() => {
    if (!open || !initialFocusRef?.current) return;
    const frame = window.requestAnimationFrame(() => initialFocusRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [initialFocusRef, open]);

  return <Modal
    open={open}
    getContainer={getContainer}
    title={title}
    aria-label={typeof title === "string" ? title : undefined}
    onCancel={onClose}
    mask={{ closable: closeOnBackdrop }}
    closable={showCloseButton ? { "aria-label": t("common.close") } : false}
    footer={footer ?? null}
    rootClassName="wf-dialog"
    className={cx("wf-overlay", className)}
    destroyOnHidden
    focusable={{ focusTriggerAfterClose: true }}
    centered
    afterOpenChange={(visible) => {
      if (visible) initialFocusRef?.current?.focus();
      afterOpenChange?.(visible);
    }}
    modalRender={(panel) => id ? <div id={id}>{panel}</div> : panel}
  >
    <div ref={contentRef} className="wf-stack">
      {description ? <div className="wf-muted">{description}</div> : null}
      {children}
    </div>
  </Modal>;
}
