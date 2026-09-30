import { useState } from "react";
import { AttachmentSlot } from "../../components/ui/fieldwork";
import { useWords } from "../../words";
import type { Attachment } from "./types";

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function AttachmentItem({ attachment }: { attachment: Attachment }) {
  const w = useWords();
  const [open, setOpen] = useState(false);
  const image = attachment.mime_type.startsWith("image/") ? attachment.preview_url : null;
  // Documents (PDF inline, Office/text as extracted plain text) preview only on request: an embedded frame is heavy.
  const doc = image ? null : attachment.preview_url;
  return (
    <AttachmentSlot
      name={attachment.filename}
      meta={formatBytes(attachment.size_bytes)}
      preview={image ? <img src={image} alt={attachment.filename} loading="lazy" />
        : doc && open ? <iframe className="cv-document" src={doc} title={attachment.filename} /> : undefined}
      actions={
        <>
          {doc && (
            <button type="button" className="cv-link-button" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? w("Hide preview", "收起预览", "收起預覽") : w("Preview", "预览", "預覽")}
            </button>
          )}
          <a href={attachment.url} download={attachment.filename}>{w("Download", "下载", "下載")}</a>
        </>
      }
    />
  );
}
