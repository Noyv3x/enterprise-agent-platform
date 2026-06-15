/* =====================================================================
   Composer attachment / clipboard helpers — ported from legacy-app.js:
   839-869 (clipboard) and 2941-2962 (optimistic attachments + blob revoke).

   `optimisticAttachments` takes the monotonic seq explicitly (the legacy code
   read the module-level `localMessageSeq`); the chat send action owns the
   counter and passes it in so this stays pure.
   ===================================================================== */

import type { Attachment } from "../types";

const PASTE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

/** Give a pasted (often nameless) clipboard image a deterministic filename. */
export function namedClipboardImage(file: File, index: number): File {
  if (file.name) return file;
  const extension = PASTE_EXTENSIONS[file.type] || "png";
  try {
    return new File([file], `pasted-image-${index + 1}.${extension}`, {
      type: file.type || "image/png",
      lastModified: file.lastModified || Date.now(),
    });
  } catch {
    return file;
  }
}

/** Extract image files from a paste event's clipboard data. */
export function clipboardImageFiles(clipboardData: DataTransfer | null): File[] {
  if (!clipboardData) return [];
  const files: File[] = [];
  for (const item of Array.from(clipboardData.items || [])) {
    if (item.kind !== "file" || !item.type?.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(namedClipboardImage(file, files.length));
  }
  if (!files.length) {
    for (const file of Array.from(clipboardData.files || [])) {
      if (file.type?.startsWith("image/")) files.push(namedClipboardImage(file, files.length));
    }
  }
  return files;
}

/** Build optimistic Attachment previews (blob: object URLs) for a pending send.
 *  Each blob URL MUST be revoked exactly once via revokeAttachmentUrls. */
export function optimisticAttachments(files: File[] | null | undefined, seq: number): Attachment[] {
  return (files || []).map((file, index) => {
    const url = URL.createObjectURL(file);
    return {
      id: `tmp-att-${seq}-${index}`,
      filename: file.name || "attachment",
      mime_type: file.type || "application/octet-stream",
      size_bytes: file.size || 0,
      is_image: (file.type || "").startsWith("image/"),
      url,
      download_url: url,
      local_preview: true,
    };
  });
}

/** Revoke any blob: preview URLs held by a message's attachments. */
export function revokeAttachmentUrls(
  message: { attachments?: Attachment[] } | null | undefined,
): void {
  for (const attachment of message?.attachments || []) {
    if (attachment.local_preview && attachment.url) {
      try {
        URL.revokeObjectURL(attachment.url);
      } catch {
        /* ignore */
      }
    }
  }
}
