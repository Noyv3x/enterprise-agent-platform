import { useI18n } from "../../i18n";
import { Button, Space } from "antd";
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
      className="eap-confirm-dialog"
      footer={
        <Space>
          <Button onClick={onCancel}>
            {cancelText ?? t("chat.confirm.cancel")}
          </Button>
          <Button
            type="primary"
            danger={danger}
            onClick={onConfirm}
          >
            {confirmText ?? t("chat.confirm.confirm")}
          </Button>
        </Space>
      }
    >
      <p className="eap-confirm-dialog__message">{message}</p>
    </Dialog>
  );
}
