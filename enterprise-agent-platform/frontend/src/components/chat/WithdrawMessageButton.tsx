import { useRef, useState } from "react";
import { Button } from "../ui/beautiful";
import { Dialog } from "../common/Dialog";
import { useI18n } from "../../i18n";

export function WithdrawMessageButton({ loading, onConfirm }: { loading: boolean; onConfirm: () => Promise<void> | void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef(false);
  const busy = loading || submitting;
  return <>
    <Button variant="ghost" disabled={busy} loading={loading} onClick={() => setOpen(true)}>{t("chat.withdraw.action")}</Button>
    <Dialog open={open} onClose={() => { if (!pending.current && !loading) setOpen(false); }}
      title={t("chat.withdraw.confirmTitle")} description={t("chat.withdraw.confirmDescription")}
      footer={<>
        <Button disabled={busy} onClick={() => setOpen(false)}>{t("chat.confirm.cancel")}</Button>
        <Button variant="danger" disabled={busy} loading={submitting} onClick={async () => {
          if (pending.current || loading) return;
          pending.current = true;
          setSubmitting(true);
          try { await onConfirm(); setOpen(false); }
          finally { pending.current = false; setSubmitting(false); }
        }}>{t("chat.withdraw.confirm")}</Button>
      </>}>{null}</Dialog>
  </>;
}
