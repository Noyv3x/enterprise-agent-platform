import { useState } from "react";
import type { ArtifactKind, AttachmentViewKind } from "../../api";
import { Button } from "../../components/ui/beautiful/atoms/Button";
import { EmptyState, Icon, Notice } from "../../components/ui/beautiful/controls";
import CodeBlock from "../../components/ui/beautiful/primitives/CodeBlock";
import { useWords } from "../../words";
import { formatBytes } from "../conversation/Attachments";
import type { Attachment } from "../conversation/types";
import type { Words } from "../conversation/work";
import { KindIcon, kindLabel } from "./kinds";
import { ImagePreview, OfficeFrame, PdfFrame } from "./renderers";
import { RendererFailed, RendererLoading, TruncatedNote, useCodeLabels, useLoaded } from "./renderers/states";
import { ICON_BUTTON, PANEL_HEAD, PANEL_SCREEN } from "./toolbar";
import { useViewUrl } from "./useViewUrl";

/** The text view URL stops at 2 MiB. */
const TEXT_LIMIT = 2 * 1024 * 1024;

const ICONS: Record<AttachmentViewKind, ArtifactKind> = { pdf: "pdf", docx: "docx", xlsx: "xlsx", pptx: "pptx", image: "image", text: "code", other: "markdown" };

function fileKindLabel(kind: AttachmentViewKind, w: Words): string {
  if (kind === "text") return w("Text", "文本", "文字");
  if (kind === "other") return w("File", "文件", "檔案");
  return kindLabel(kind, w);
}

/** The 作品 panel's file mode: one attachment (uploaded or delivered), with its name, 下载 and 关闭, no versions. It
 * shows through a token-scoped view URL (`POST /api/attachments/{id}/view`, re-minted before it expires): PDF in the
 * browser's viewer, Office files in the sandboxed Office viewer, images as an `<img>`, text as code. */
export function FileViewer({ file, onClose }: { file: Attachment; onClose: () => void }) {
  const w = useWords();
  const [nonce, setNonce] = useState(0);
  const kind = file.view_kind;
  const view = useViewUrl(kind === "other" ? null : `/api/attachments/${file.id}/view`, nonce);

  let body;
  if (kind === "other") {
    body = (
      <EmptyState
        className="absolute inset-0"
        icon="download"
        title={w("No preview for this file type", "这种文件无法预览", "這種檔案無法預覽")}
        description={w("Download it to open it on your computer.", "下载后可在电脑上打开。", "下載後可在電腦上開啟。")}
      />
    );
  } else if (view.error && !view.url) {
    body = (
      <div className="absolute inset-0 overflow-auto p-4">
        <Notice tone="danger" title={w("The file could not be opened", "无法打开文件", "無法開啟檔案")}
          action={<Button size="xs" className="touch:h-11" onClick={() => setNonce((value) => value + 1)}>{w("Retry", "重试", "重試")}</Button>}>
          {view.error}
        </Notice>
      </div>
    );
  } else if (!view.url) {
    body = <RendererLoading />;
  } else if (kind === "pdf") {
    body = <PdfFrame src={view.url} title={file.filename} />;
  } else if (kind === "image") {
    body = <ImagePreview viewUrl={view.url} title={file.filename} vector={file.mime_type === "image/svg+xml"} refreshable={false} />;
  } else if (kind === "text") {
    body = <TextFile id={file.id} url={view.url} filename={file.filename} truncated={file.size_bytes > TEXT_LIMIT} />;
  } else {
    body = <OfficeFrame src={view.url} title={file.filename} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={PANEL_HEAD}>
        <span aria-hidden className="ml-1.5 flex size-7 shrink-0 items-center justify-center rounded-control bg-accent-tint text-accent-ink">
          <KindIcon kind={ICONS[kind]} size={14} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="truncate text-[13px] font-semibold text-ink" title={file.filename}>{file.filename}</h3>
          <span className="truncate text-[12px] text-ink-2 tabular-nums">{`${fileKindLabel(kind, w)} · ${formatBytes(file.size_bytes)}`}</span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <a href={file.url} download={file.filename} aria-label={w(`Download ${file.filename}`, `下载 ${file.filename}`, `下載 ${file.filename}`)}
            title={w("Download", "下载", "下載")} className={ICON_BUTTON}>
            <Icon name="download" size={14} />
          </a>
          <button type="button" onClick={onClose} aria-label={w("Close file", "关闭文件", "關閉檔案")} title={w("Close file", "关闭文件", "關閉檔案")} className={ICON_BUTTON}>
            <Icon name="close" size={13} strokeWidth={2.2} />
          </button>
        </div>
      </div>
      <section aria-label={file.filename} className={PANEL_SCREEN}>
        <div className="absolute inset-0 flex flex-col">{body}</div>
      </section>
    </div>
  );
}

/** A text attachment from its view URL (UTF-8, at most 2 MiB) in CodeBlock, named after the file. */
function TextFile({ id, url, filename, truncated }: { id: number; url: string; filename: string; truncated: boolean }) {
  const w = useWords();
  const labels = useCodeLabels();
  // Loaded once per file: a re-minted URL does not reload it, a retry uses the newest one.
  const loaded = useLoaded<string>(async () => {
    const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" });
    if (!response.ok) throw new Error(w(`The file could not be read (HTTP ${response.status}).`, `无法读取文件（HTTP ${response.status}）。`, `無法讀取檔案（HTTP ${response.status}）。`));
    return response.text();
  }, String(id));
  if (loaded.status === "loading") return <RendererLoading />;
  if (loaded.status === "failed") {
    return <RendererFailed error={loaded.error} retry={loaded.retry} title={w("Couldn't load this file", "无法载入文件内容", "無法載入檔案內容")} />;
  }
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      {truncated && <TruncatedNote className="shrink-0" />}
      <div className="min-h-0 flex-1">
        <CodeBlock fill fillHeight code={loaded.value} filename={filename} labels={labels} />
      </div>
    </div>
  );
}
