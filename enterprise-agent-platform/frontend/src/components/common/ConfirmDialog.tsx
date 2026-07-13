import { useI18n } from "../../i18n";
import { cx } from "../../lib/cx";
import { Dialog } from "./Dialog";

export interface ConfirmDialogProps {
  message: string;
  title?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Promise-friendly confirmation surface using the shared accessible modal. */
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
  return (
    <Dialog
      open
      onClose={onCancel}
      title={title || t("chat.confirm.label")}
      showCloseButton={false}
      className="modal__panel--confirm"
      footer={
        <>
          <button className="btn" type="button" onClick={onCancel}>
            {cancelText ?? t("chat.confirm.cancel")}
          </button>
          <button
            className={cx("btn", danger ? "btn--danger" : "btn--primary")}
            type="button"
            onClick={onConfirm}
          >
            {confirmText ?? t("chat.confirm.confirm")}
          </button>
        </>
      }
    >
      <p className="modal__message">{message}</p>
    </Dialog>
  );
}
