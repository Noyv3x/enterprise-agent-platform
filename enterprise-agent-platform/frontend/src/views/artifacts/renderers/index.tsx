/** Artifact renderers (frontend.md § Artifacts): the 预览 of every kind except web/site (the panel's WebFrame), the
 * 源码 view and the 对比上一版 diff. Each fills its parent and scrolls itself; the panel re-mounts it by key. The PDF
 * and Office frames and the image view also show attachments in the panel's file mode. */
import { useState } from "react";
import { Notice } from "../../../components/ui/beautiful/controls";
import CodeBlock from "../../../components/ui/beautiful/primitives/CodeBlock";
import { useI18n } from "../../../i18n";
import { useWords } from "../../../words";
import "../../../components/ui/beautiful/primitives/streamingText.css";
import { Markdown } from "../../conversation/Markdown";
import type { ArtifactRendererProps, ArtifactSource } from "../types";
import { MermaidDiagram } from "./MermaidDiagram";
import { RendererFailed, RendererLoading, TruncatedNote, useCodeLabels, useLoaded } from "./states";
import { TableView } from "./TableView";

export { ArtifactDiff } from "./DiffView";
export { MermaidDiagram } from "./MermaidDiagram";
export { ArtifactSourceView } from "./SourceView";

/** Markdown, Mermaid, table and code: the entry's text from the source endpoint. */
function TextPreview({ kind, entry, version, loadSource }: Pick<ArtifactRendererProps, "entry" | "version" | "loadSource"> & { kind: "markdown" | "mermaid" | "table" | "code" }) {
  const labels = useCodeLabels();
  const loaded = useLoaded<ArtifactSource>(() => loadSource(), `${version}:${entry}`);
  if (loaded.status === "loading") return <RendererLoading />;
  if (loaded.status === "failed") return <RendererFailed error={loaded.error} retry={loaded.retry} />;
  const { content, truncated } = loaded.value;

  if (kind === "mermaid") return <MermaidDiagram fill source={content} />;
  if (kind === "table") return <TableView text={content} truncated={truncated} tsv={entry.toLowerCase().endsWith(".tsv")} />;
  if (kind === "code") {
    return (
      <div className="flex h-full min-h-0 flex-col gap-3 p-3">
        {truncated && <TruncatedNote className="shrink-0" />}
        <div className="min-h-0 flex-1">
          <CodeBlock fill fillHeight code={content} filename={entry} labels={labels} />
        </div>
      </div>
    );
  }
  return (
    <div className="h-full min-h-0 overflow-y-auto" tabIndex={0}>
      <article className="bui-prose mx-auto max-w-[72ch] px-6 py-6 text-[14px] leading-[1.7] text-ink max-sm:px-4">
        {truncated && <TruncatedNote />}
        <Markdown content={content} />
      </article>
    </div>
  );
}

/** SVG and raster images through the view URL: an `<img>` never runs a document's scripts. `refreshable`: the panel
 * around it has 刷新. */
export function ImagePreview({ viewUrl, title, vector, refreshable = true }: { viewUrl: string; title: string; vector: boolean; refreshable?: boolean }) {
  const w = useWords();
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="p-4">
        <Notice tone="danger" title={w("Couldn't show this image", "无法显示图片", "無法顯示圖片")}>
          {refreshable
            ? w("Use Refresh to try again, or download the file.", "可以点「刷新」重试，或下载文件查看。", "可以點「重新整理」重試，或下載檔案查看。")
            : w("Download the file to view it.", "可以下载文件查看。", "可以下載檔案查看。")}
        </Notice>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-canvas p-6">
      <img
        src={viewUrl}
        alt={title}
        onError={() => setFailed(true)}
        className={vector ? "h-full w-full object-contain" : "max-h-full max-w-full rounded-control object-contain shadow-card"}
      />
    </div>
  );
}

/** A PDF through its view URL. The view route's CSP sandboxes the document (opaque origin); a sandbox attribute would
 * block the browser's PDF viewer. */
export function PdfFrame({ src, title }: { src: string; title: string }) {
  return <iframe src={src} title={title} referrerPolicy="no-referrer" className="block h-full w-full border-0 bg-canvas" />;
}

/** A DOCX, XLSX or PPTX in Platform's Office viewer: the view URL is the viewer page itself, which renders the file
 * in an opaque origin without network access, so it gets scripts and nothing else. */
export function OfficeFrame({ src, title }: { src: string; title: string }) {
  const { locale } = useI18n();
  // The viewer's own messages and page language follow the app's (`lang` query; the viewer falls back to the browser's).
  const localized = `${src}${src.includes("?") ? "&" : "?"}lang=${locale}`;
  return <iframe src={localized} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" className="block h-full w-full border-0 bg-canvas" />;
}

export function ArtifactPreview({ artifact, version, entry, viewUrl, loadSource }: ArtifactRendererProps) {
  const { kind } = artifact;
  if (kind === "markdown" || kind === "mermaid" || kind === "table" || kind === "code") {
    return <TextPreview kind={kind} entry={entry} version={version} loadSource={loadSource} />;
  }
  if (kind === "web" || kind === "site") return null;
  if (!viewUrl) return <RendererLoading />;
  if (kind === "pdf") return <PdfFrame src={viewUrl} title={artifact.title} />;
  if (kind === "docx" || kind === "xlsx" || kind === "pptx") return <OfficeFrame src={viewUrl} title={artifact.title} />;
  return <ImagePreview viewUrl={viewUrl} title={artifact.title} vector={kind === "svg"} />;
}
