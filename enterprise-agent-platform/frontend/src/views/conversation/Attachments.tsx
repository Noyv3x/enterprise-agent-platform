import { useContext } from "react";
import ContextCards, { CONTEXT_CHIP, type ContextFile } from "../../components/ui/beautiful/primitives/ContextCards";
import { useWords } from "../../words";
import { ArtifactsContext } from "../artifacts/ArtifactCards";
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

/** Message attachments and delivered `MEDIA:` files as ContextCards: download, image thumbnails, and 打开 (or a click
 * on the thumbnail), which shows the file in the side panel's file mode. Nothing expands inside the message. */
export function AttachmentCards({ attachments, className }: { attachments: Attachment[]; className?: string }) {
  const w = useWords();
  const opener = useContext(ArtifactsContext);
  const files: ContextFile[] = attachments.map((attachment) => {
    const extension = attachment.filename.includes(".") ? attachment.filename.split(".").pop()!.toLowerCase() : "";
    const image = attachment.mime_type.startsWith("image/");
    const viewable = opener !== null && attachment.view_kind !== "other";
    const showing = opener?.currentFile === attachment.id;
    const openLabel = w(`Open ${attachment.filename}`, `打开 ${attachment.filename}`, `開啟 ${attachment.filename}`);
    const thumbnail = image && attachment.preview_url
      ? <img src={attachment.preview_url} alt={attachment.filename} loading="lazy" className="max-h-56 w-auto max-w-full rounded-[6px] shadow-hairline" />
      : undefined;
    return {
      key: attachment.id,
      title: attachment.filename,
      chars: formatBytes(attachment.size_bytes),
      badge: image ? "IMG" : (extension || "FILE").slice(0, 4).toUpperCase(),
      tone: image ? "bg-orange" : TONE_BY_EXTENSION[extension] ?? "bg-ink-2",
      href: attachment.url,
      downloadLabel: `${w("Download", "下载", "下載")} ${attachment.filename}`,
      // The thumbnail repeats the 打开 chip for the pointer; keyboard and screen readers use the chip.
      body: thumbnail && viewable ? (
        <button type="button" tabIndex={-1} aria-hidden onClick={() => opener.openFile(attachment)}
          className="block max-w-full cursor-zoom-in rounded-[6px] transition-opacity duration-150 hover:opacity-90">
          {thumbnail}
        </button>
      ) : thumbnail,
      actions: viewable ? (
        <button type="button" className={CONTEXT_CHIP} aria-label={openLabel} aria-current={showing || undefined} onClick={() => opener.openFile(attachment)}>
          {showing ? w("Showing", "已打开", "已開啟") : w("Open", "打开", "開啟")}
        </button>
      ) : undefined,
    };
  });
  return <ContextCards files={files} className={className} />;
}
