/* <AuditMessageRow/> — one message in an audit list (legacy renderAuditMessageRow,
   legacy-app.js:1966-1985). Reuses the shared <MessageAttachments> atom (which runs
   hrefs/srcs through safeUrl). The trash button shows only when deletable. */

import { cx } from "../../../lib/cx";
import { formatTimestamp } from "../../../utils/format";
import type { Message } from "../../../types";
import { Icon } from "../../common/Icon";
import { MessageAttachments } from "../../common/MessageAttachments";

export interface AuditMessageRowProps {
  message: Message;
  deletable?: boolean;
  onDelete?: () => void;
}

export function AuditMessageRow({ message, deletable = false, onDelete }: AuditMessageRowProps) {
  const author = message.username || (message.author_type === "agent" ? "Agent" : "User");
  return (
    <article className={cx("audit-message", `audit-message--${message.author_type}`)}>
      <div className="audit-message__meta">
        <span className="mono">{`#${message.id}`}</span>
        <strong>{author}</strong>
        <span>{message.author_type}</span>
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
            title="删除消息"
            aria-label="删除消息"
            onClick={() => onDelete?.()}
          >
            <Icon name="trash" size={16} />
          </button>
        </div>
      ) : null}
    </article>
  );
}
