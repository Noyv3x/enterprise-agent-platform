import { Button, Space } from "antd";
import { useI18n } from "../../../i18n";
import type { Message } from "../../../types";
import { formatTimestamp } from "../../../utils/format";
import { MessageAttachments } from "../../common/MessageAttachments";
import { ResourceRow, StatusMark } from "../../ui/fieldwork";

export interface AuditMessageRowProps {
  message: Message;
  deletable?: boolean;
  onDelete?: () => void;
}

export function AuditMessageRow({ message, deletable = false, onDelete }: AuditMessageRowProps) {
  const { t } = useI18n();
  const authorType = message.author_type === "agent" ? t("admin.audit.agent") : message.author_type === "user" ? t("admin.audit.user") : message.author_type;
  return (
    <article aria-label={`#${message.id}`}>
      <ResourceRow
        title={message.username || authorType}
        meta={<Space wrap><span>#{message.id}</span><span>{formatTimestamp(message.created_at)}</span></Space>}
        status={<StatusMark>{authorType}</StatusMark>}
        actions={onDelete ? <Button danger disabled={!deletable} onClick={onDelete}>{t("admin.audit.deleteMessage")}</Button> : undefined}
      >
        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{message.content}</div>
        {message.attachments?.length ? <MessageAttachments attachments={message.attachments} /> : null}
      </ResourceRow>
    </article>
  );
}
