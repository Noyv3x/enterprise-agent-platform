import { Button, FormFooter } from "../ui/beautiful";
import { useI18n } from "../../i18n";
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
      // Restore the opener before the owner unmounts this confirmation.
      if (decision) onConfirm();
      else onCancel();
    }}
    footer={
      <FormFooter>
        <Button onClick={() => close(false)} disabled={decision !== null}>{cancelText ?? t("chat.confirm.cancel")}</Button>
        <Button variant={danger ? "danger" : "primary"} onClick={() => close(true)} disabled={decision !== null}>{confirmText ?? t("chat.confirm.confirm")}</Button>
      </FormFooter>
    }
  >
    <p>{message}</p>
  </Dialog>;
}
