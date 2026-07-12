/* <AuditMessageRow/> — one message in an audit list (legacy renderAuditMessageRow,
   legacy-app.js:1966-1985). Reuses the shared <MessageAttachments> atom (which runs
   hrefs/srcs through safeUrl). The trash button shows only when deletable. */

import { cx } from "../../../lib/cx";
import { formatTimestamp } from "../../../utils/format";
import type { Message } from "../../../types";
import { Icon } from "../../common/Icon";
import { MessageAttachments } from "../../common/MessageAttachments";
import { useI18n } from "../../../i18n";

export interface AuditMessageRowProps {
  message: Message;
  deletable?: boolean;
  onDelete?: () => void;
}

export function AuditMessageRow({ message, deletable = false, onDelete }: AuditMessageRowProps) {
  const { t } = useI18n();
  const author = message.username || t(message.author_type === "agent" ? "admin.audit.agent" : "admin.audit.user");
  const authorType = message.author_type === "agent"
    ? t("admin.audit.agent")
    : message.author_type === "user"
      ? t("admin.audit.user")
      : message.author_type;
  return (
    <article className={cx("audit-message", `audit-message--${message.author_type}`)}>
      <div className="audit-message__meta">
        <span className="mono">{`#${message.id}`}</span>
        <strong>{author}</strong>
        <span>{authorType}</span>
        <span>{formatTimestamp(message.created_at)}</span>
      </div>
      <div className="audit-message__body">{message.content}</div>
      {message.attachments?.length ? (
        <MessageAttachments attachments={message.attachments} />
      ) : null}
      {deletable ? (
        <div className="audit-message__actions">
          <button
            className="icon-btn"
            type="button"
            title={t("admin.audit.deleteMessage")}
            aria-label={t("admin.audit.deleteMessage")}
            onClick={() => onDelete?.()}
          >
            <Icon name="trash" size={16} />
          </button>
        </div>
      ) : null}
    </article>
  );
}
