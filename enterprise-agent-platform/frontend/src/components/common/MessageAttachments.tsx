import { safeUrl } from "../../lib/api";
import { useI18n } from "../../i18n";
import { formatFileSize } from "../../utils/format";
import type { Attachment } from "../../types";
import { AttachmentSlot } from "../ui/beautiful"
import { AttachmentPreviewCard } from "./AttachmentPreviewCard";
import { Icon } from "./Icon";
import "../preview/preview.css";

export function MessageAttachments({ attachments }: { attachments: Attachment[] }) {
  const { t } = useI18n();
  return <div className="bui-message-files">
    {attachments.map((attachment) => {
      const name = attachment.filename || t("chat.attachment");
      const download = safeUrl(attachment.download_url || attachment.url);
      const html = /\.html?$/i.test(name) || attachment.mime_type?.split(";")[0].trim().toLowerCase() === "text/html";
      let image = "";
      if (attachment.is_image && !html) {
        const source = safeUrl(attachment.url);
        try {
          const url = new URL(source, window.location.origin);
          if (source && url.origin === window.location.origin && !url.username && !url.password && (
            (attachment.local_preview && url.protocol === "blob:") ||
            (url.protocol === window.location.protocol && url.pathname === `/api/attachments/${encodeURIComponent(String(attachment.id))}`)
          )) image = source;
        } catch { /* Never fetch untrusted image sources. */ }
      }
      if (!html && !attachment.is_image && attachment.preview_url) {
        return <AttachmentPreviewCard key={String(attachment.id)} attachment={attachment} />;
      }
      return <AttachmentSlot key={String(attachment.id)} name={name}
        meta={`${attachment.mime_type || t("chat.file")} · ${formatFileSize(attachment.size_bytes || 0)}`}
        actions={download ? <a className="bui-attachment-download" aria-label={t("chat.preview.download")} title={t("chat.preview.download")} href={download} target="_blank" rel="noreferrer"><Icon name="download" size={18} /></a> : undefined}
        preview={image ? <div className="bui-attachment-image"><img src={image} alt={name} loading="lazy" /></div> : undefined}
      />;
    })}
  </div>;
}
