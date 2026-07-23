import { Drawer as AntDrawer } from "antd";
import { useEffect } from "react";
import type { DialogProps } from "./Dialog";
import { useModalLayer, useTopLayerEscape } from "./modalStack";

/** Responsive workspace drawer backed by Ant Design's focus-managed Drawer. */
export function Drawer({
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
  const isTopLayer = useModalLayer(open);
  useTopLayerEscape(isTopLayer, onClose);
  useEffect(() => {
    if (!open || !initialFocusRef?.current) return;
    const frame = window.requestAnimationFrame(() => initialFocusRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [initialFocusRef, open]);

  return (
    <AntDrawer
      open={open}
      onClose={onClose}
      title={title}
      aria-label={typeof title === "string" ? title : undefined}
      footer={footer}
      className={className}
      rootClassName="eap-drawer-root"
      mask={{ closable: closeOnBackdrop && isTopLayer }}
      closable={showCloseButton}
      keyboard={false}
      destroyOnHidden
      size={520}
      id={id}
    >
      {description ? <p className="eap-dialog__description">{description}</p> : null}
      {children}
    </AntDrawer>
  );
}
