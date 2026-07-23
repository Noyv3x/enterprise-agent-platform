import { Modal } from "antd";
import { useEffect, type ReactNode } from "react";
import { useI18n } from "../../i18n";
import { useModalLayer, useTopLayerEscape } from "./modalStack";

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
  /** Focus this element after the panel opens. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}

/** Product-level dialog API backed by Ant Design's focus-managed Modal. */
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
}: DialogProps) {
  const { t } = useI18n();
  const isTopLayer = useModalLayer(open);
  useTopLayerEscape(isTopLayer, onClose);

  useEffect(() => {
    if (!open || !initialFocusRef?.current) return;
    const frame = window.requestAnimationFrame(() => initialFocusRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [initialFocusRef, open]);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={title}
      aria-label={typeof title === "string" ? title : undefined}
      footer={footer ?? null}
      className={className}
      rootClassName="eap-dialog-root"
      mask={{ closable: closeOnBackdrop && isTopLayer }}
      closable={showCloseButton}
      closeIcon={<span aria-label={t("common.close")}>×</span>}
      keyboard={false}
      destroyOnHidden
      centered
      modalRender={(node) => id ? <div id={id}>{node}</div> : node}
    >
      {description ? <p className="eap-dialog__description">{description}</p> : null}
      {children}
    </Modal>
  );
}
