import { Button } from "antd";
import { useI18n } from "../../i18n";
import { FormFooter } from "../ui/fieldwork";
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

export function ConfirmDialog({ message, title, confirmText, cancelText, danger, onConfirm, onCancel }: ConfirmDialogProps) {
  const { t } = useI18n();
  return <Dialog open onClose={onCancel} title={title || t("chat.confirm.label")} showCloseButton={false}
    footer={<FormFooter>
      <Button onClick={onCancel}>{cancelText ?? t("chat.confirm.cancel")}</Button>
      <Button type="primary" danger={danger} onClick={onConfirm}>{confirmText ?? t("chat.confirm.confirm")}</Button>
    </FormFooter>}
  >
    <p className="wf-reading">{message}</p>
  </Dialog>;
}
