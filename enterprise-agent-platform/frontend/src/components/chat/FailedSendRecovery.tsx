import { useI18n } from "../../i18n";
import type { FailedSend } from "../../types";
import { Icon } from "../common/Icon";

function summary(send: FailedSend, fallback: string): string {
  const text = send.content.trim().replace(/\s+/g, " ");
  if (text) return text;
  return send.files.map((file) => file.name).filter(Boolean).join(", ") || fallback;
}

export function FailedSendRecovery({
  sends,
  blocked,
  onRestore,
}: {
  sends: FailedSend[];
  blocked: boolean;
  onRestore: () => void;
}) {
  const { t } = useI18n();
  const next = sends[0];
  if (!next) return null;

  return (
    <section className="failed-send" role="status" aria-live="polite">
      <span className="failed-send__icon" aria-hidden="true">
        <Icon name="alert" size={15} />
      </span>
      <div className="failed-send__body">
        <strong>{t("chat.failedSend.title", { count: sends.length })}</strong>
        <span title={summary(next, t("chat.attachment"))}>
          {summary(next, t("chat.attachment"))}
          {next.files.length
            ? ` · ${t("chat.failedSend.attachments", { count: next.files.length })}`
            : ""}
        </span>
      </div>
      <button
        className="btn btn--sm"
        type="button"
        disabled={blocked}
        title={blocked ? t("chat.failedSend.restoreBlocked") : undefined}
        onClick={onRestore}
      >
        {t("chat.failedSend.restore")}
      </button>
    </section>
  );
}
