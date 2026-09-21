import { Button, Tooltip } from "../ui/beautiful"
import { useI18n } from "../../i18n";
import type { FailedSend } from "../../types";
import { Notice } from "../ui/beautiful"

function summary(send: FailedSend, fallback: string): string {
  const text = send.content.trim().replace(/\s+/g, " ");
  return text || send.files.map((file) => file.name).filter(Boolean).join(", ") || fallback;
}

export function FailedSendRecovery({ sends, blocked, onRestore }: { sends: FailedSend[]; blocked: boolean; onRestore: () => void }) {
  const { t } = useI18n();
  const next = sends[0];
  if (!next) return null;
  return <Notice tone="warning" title={t("chat.failedSend.title", { count: sends.length })} action={
    <Tooltip title={blocked ? t("chat.failedSend.restoreBlocked") : undefined}>
      <Button type="button" disabled={blocked} onClick={onRestore}>{t("chat.failedSend.restore")}</Button>
    </Tooltip>
  }>
    <div className="bui-draft-recovery-text">{summary(next, t("chat.attachment"))}</div>
    {next.files.length > 0 && <span>{t("chat.failedSend.attachments", { count: next.files.length })}</span>}
  </Notice>;
}
