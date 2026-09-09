import { Modal } from "antd";
import { useEffect, type ReactNode, type RefObject } from "react";
import { useI18n } from "../../i18n";
import { cx } from "../../lib/cx";
import { useModalLayer, useTopLayerEscape } from "./modalStack";
import { useFieldworkContainer } from "../ui/fieldwork";

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
  const isTopLayer = useModalLayer(open);
  const getContainer = useFieldworkContainer();
  useTopLayerEscape(isTopLayer, onClose);

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
    keyboard={false}
    mask={{ closable: closeOnBackdrop && isTopLayer }}
    closable={showCloseButton ? { "aria-label": t("common.close") } : false}
    footer={footer ?? null}
    rootClassName="wf-dialog"
    className={cx("wf-overlay", className)}
    destroyOnHidden
    focusTriggerAfterClose
    centered
    afterOpenChange={(visible) => {
      if (visible) initialFocusRef?.current?.focus();
      afterOpenChange?.(visible);
    }}
    modalRender={(panel) => id ? <div id={id}>{panel}</div> : panel}
  >
    <div className="wf-stack">
      {description ? <div className="wf-muted">{description}</div> : null}
      {children}
    </div>
  </Modal>;
}
