import { Button } from "antd";
import { useI18n } from "../../i18n";
import { FormFooter } from "../ui/fieldwork";
import { Dialog } from "./Dialog";
import { useState } from "react";

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
  const [decision, setDecision] = useState<boolean | null>(null);
  const close = (confirmed: boolean) => setDecision((current) => current ?? confirmed);
  return <Dialog
    open={decision === null}
    onClose={() => close(false)}
    title={title || t("chat.confirm.label")}
    showCloseButton={false}
    afterOpenChange={(open) => {
      if (open || decision === null) return;
      // Let Ant restore focus before the owner unmounts this confirmation.
      if (decision) onConfirm();
      else onCancel();
    }}
    footer={
      <FormFooter>
        <Button onClick={() => close(false)} disabled={decision !== null}>{cancelText ?? t("chat.confirm.cancel")}</Button>
        <Button type="primary" danger={danger} onClick={() => close(true)} disabled={decision !== null}>{confirmText ?? t("chat.confirm.confirm")}</Button>
      </FormFooter>
    }
  >
    <p className="wf-reading">{message}</p>
  </Dialog>;
}
