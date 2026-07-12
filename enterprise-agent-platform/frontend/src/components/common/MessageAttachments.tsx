/* <MessageAttachments/> — port of legacy renderMessageAttachments
   (legacy-app.js:901-932). Shared by the chat message bubbles and the admin
   message-audit rows. Every backend-supplied href/src runs through safeUrl
   (JSX does NOT block javascript: URLs); image src additionally allows
   data:/blob: for inline + optimistic previews. */

import { safeUrl } from "../../lib/api";
import { useI18n } from "../../i18n";
import { formatFileSize } from "../../utils/format";
import type { Attachment } from "../../types";
import { Icon } from "./Icon";

export function MessageAttachments({ attachments }: { attachments: Attachment[] }) {
  const { t } = useI18n();
  return (
    <div className="msg-attachments">
      {attachments.map((attachment) => {
        const name = attachment.filename || t("chat.attachment");
        const size = formatFileSize(attachment.size_bytes || 0);
        const href = safeUrl(attachment.download_url || attachment.url);
        if (attachment.is_image) {
          return (
            <a
              key={String(attachment.id)}
              className="msg-attachment msg-attachment--image"
              href={href}
              target="_blank"
              rel="noreferrer"
              title={name}
            >
              <img src={safeUrl(attachment.url, { allowData: true })} alt={name} loading="lazy" />
              <span className="msg-attachment__caption">{`${name} · ${size}`}</span>
            </a>
          );
        }
        return (
          <a
            key={String(attachment.id)}
            className="msg-attachment msg-attachment--file"
            href={href}
            target="_blank"
            rel="noreferrer"
            title={name}
          >
            <span className="msg-attachment__fileicon">
              <Icon name="doc" size={18} />
            </span>
            <span className="msg-attachment__meta">
              <strong>{name}</strong>
              <span>{`${attachment.mime_type || t("chat.file")} · ${size}`}</span>
            </span>
            <Icon name="download" size={16} />
          </a>
        );
      })}
    </div>
  );
}
