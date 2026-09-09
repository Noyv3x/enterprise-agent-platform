import { Drawer as AntDrawer } from "antd";
import { useRef } from "react";
import { useI18n } from "../../i18n";
import { cx } from "../../lib/cx";
import type { DialogProps } from "./Dialog";
import { useFieldworkContainer } from "../ui/fieldwork";
import { useModalLayer, useTopLayerEscape } from "./modalStack";
import { Icon } from "./Icon";

export function Drawer({ id, open, onClose, title, description, children, footer, className,
  closeOnBackdrop = true, showCloseButton = true, initialFocusRef, afterOpenChange }: DialogProps) {
  const { t } = useI18n();
  const isTopLayer = useModalLayer(open);
  const getContainer = useFieldworkContainer();
  const closeIcon = useRef<HTMLSpanElement | null>(null);
  useTopLayerEscape(isTopLayer, onClose);

  return <AntDrawer
    id={id}
    open={open}
    title={title}
    getContainer={getContainer}
    aria-label={typeof title === "string" ? title : undefined}
    onClose={onClose}
    keyboard={false}
    mask={{ closable: closeOnBackdrop && isTopLayer }}
    closable={showCloseButton ? { "aria-label": t("common.close") } : false}
    closeIcon={<span ref={closeIcon}><Icon name="close" /></span>}
    footer={footer}
    className={cx("wf-overlay", className)}
    classNames={{ root: "wf-drawer", header: "wf-drawer-header", body: "wf-drawer-body", footer: "wf-drawer-footer" }}
    size="min(100vw, 640px)"
    destroyOnHidden
    afterOpenChange={(visible) => {
      if (visible) {
        const target = initialFocusRef?.current ?? closeIcon.current?.closest<HTMLButtonElement>("button");
        const dialog = target?.closest('[role="dialog"]');
        if (dialog && !dialog.contains(document.activeElement)) target?.focus({ preventScroll: true });
      }
      afterOpenChange?.(visible);
    }}
  >
    <div className="wf-stack">
      {description ? <div className="wf-muted">{description}</div> : null}
      {children}
    </div>
  </AntDrawer>;
}
