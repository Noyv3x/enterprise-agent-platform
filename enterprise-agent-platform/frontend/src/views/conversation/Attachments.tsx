import { useState } from "react";
import ContextCards, { CONTEXT_CHIP, type ContextFile } from "../../components/ui/beautiful/primitives/ContextCards";
import { useWords } from "../../words";
import type { Attachment } from "./types";

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

const TONE_BY_EXTENSION: Record<string, string> = {
  pdf: "bg-red", csv: "bg-green", xls: "bg-green", xlsx: "bg-green", doc: "bg-accent", docx: "bg-accent",
  ppt: "bg-orange", pptx: "bg-orange", md: "bg-ink-2", txt: "bg-ink-2", json: "bg-ink-2", zip: "bg-ink-2",
};

/** Message attachments and delivered `MEDIA:` files as ContextCards: image thumbnails inline, documents on request. */
export function AttachmentCards({ attachments, className }: { attachments: Attachment[]; className?: string }) {
  const w = useWords();
  const [open, setOpen] = useState<number | null>(null);
  const files: ContextFile[] = attachments.map((attachment) => {
    const extension = attachment.filename.includes(".") ? attachment.filename.split(".").pop()!.toLowerCase() : "";
    const image = attachment.mime_type.startsWith("image/");
    // Documents (PDF inline, Office/text as extracted plain text) preview only on request: an embedded frame is heavy.
    const documentPreview = !image && attachment.preview_url;
    const previewing = open === attachment.id;
    return {
      key: attachment.id,
      title: attachment.filename,
      chars: formatBytes(attachment.size_bytes),
      badge: image ? "IMG" : (extension || "FILE").slice(0, 4).toUpperCase(),
      tone: image ? "bg-orange" : TONE_BY_EXTENSION[extension] ?? "bg-ink-2",
      href: attachment.url,
      downloadLabel: `${w("Download", "下载", "下載")} ${attachment.filename}`,
      body: image && attachment.preview_url
        ? <img src={attachment.preview_url} alt={attachment.filename} loading="lazy" className="max-h-56 w-auto max-w-full rounded-[6px] shadow-hairline" />
        : documentPreview && previewing
          ? <iframe src={attachment.preview_url!} title={attachment.filename} className="h-72 w-full rounded-[6px] bg-surface shadow-hairline" />
          : undefined,
      actions: documentPreview ? (
        <button type="button" className={CONTEXT_CHIP} aria-expanded={previewing} onClick={() => setOpen(previewing ? null : attachment.id)}>
          {previewing ? w("Hide preview", "收起预览", "收起預覽") : w("Preview", "预览", "預覽")}
        </button>
      ) : undefined,
    };
  });
  return <ContextCards files={files} className={className} />;
}
