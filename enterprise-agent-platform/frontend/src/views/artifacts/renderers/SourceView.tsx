/** 源码: the entry (or a picked site file) in a CodeBlock; sites list their files beside it, or in a Select when the
 * panel is narrow. */
import { useMemo, useState } from "react";
import { EmptyState, Select, type SelectOption } from "../../../components/ui/beautiful/controls";
import CodeBlock from "../../../components/ui/beautiful/primitives/CodeBlock";
import { useWords } from "../../../words";
import { formatBytes } from "../../conversation/Attachments";
import type { ArtifactFile, ArtifactRendererProps, ArtifactSource } from "../types";
import { RendererFailed, RendererLoading, TruncatedNote, useCodeLabels, useLoaded } from "./states";

/** MIME types the source endpoint serves as text, as Platform decides it (`artifacts.py`): `text/*`, JSON, XML,
 * JavaScript, web app manifests and SVG. Parameters (`; charset=utf-8`) do not matter. */
const TEXT_MIME = /^(?:text\/[^;\s]+|application\/(?:json|xml|javascript|manifest\+json)|image\/svg\+xml)\s*(?:;|$)/i;

/** One file's source; `file` is its entry in the loaded file list (missing: read it as text). */
function SourceFile({ path, file, version, loadSource }: { path: string; file: ArtifactFile | undefined; version: number; loadSource: (path?: string) => Promise<ArtifactSource> }) {
  const w = useWords();
  const labels = useCodeLabels();
  const binary = file !== undefined && !TEXT_MIME.test(file.mime);
  const loaded = useLoaded<ArtifactSource | null>(() => (binary ? Promise.resolve(null) : loadSource(path)), `${version}:${path}:${binary}`);
  if (loaded.status === "loading") return <RendererLoading />;
  if (loaded.status === "failed") return <RendererFailed error={loaded.error} retry={loaded.retry} />;
  if (!loaded.value) {
    return (
      <EmptyState
        icon="eye"
        className="h-full"
        title={w("This file isn't text", "这个文件不是文本", "這個檔案不是文字")}
        description={`${file?.mime ?? ""} · ${formatBytes(file?.size ?? 0)} · ${w("Preview or download it instead.", "可在预览中查看或下载。", "可在預覽中查看或下載。")}`}
      />
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {loaded.value.truncated && <TruncatedNote className="shrink-0" />}
      <div className="min-h-0 flex-1">
        <CodeBlock fill fillHeight code={loaded.value.content} filename={path} labels={labels} />
      </div>
    </div>
  );
}

export function ArtifactSourceView({ artifact, version, entry, loadSource, files }: ArtifactRendererProps & {
  /** the version's files; null while they load */
  files: ArtifactFile[] | null;
}) {
  const w = useWords();
  const [selected, setSelected] = useState(entry);
  const sorted = useMemo(() => [...(files ?? [])].sort((a, b) => (a.path === entry ? -1 : b.path === entry ? 1 : a.path.localeCompare(b.path))), [files, entry]);
  const listed = artifact.kind === "site" || sorted.length > 1;
  const entryLabel = w("entry", "入口", "入口");
  const options: SelectOption[] = sorted.map((file) => ({
    value: file.path,
    label: file.path,
    description: file.path === entry ? `${entryLabel} · ${formatBytes(file.size)}` : formatBytes(file.size),
  }));
  // The file list says whether the file is text; until it arrives nothing is read (an image would fail with 415).
  const source = files === null ? <RendererLoading /> : (
    <SourceFile key={selected} path={selected} file={sorted.find((file) => file.path === selected)} version={version} loadSource={loadSource} />
  );
  if (!listed) return <div className="h-full min-h-0 p-3">{source}</div>;

  const filesLabel = w("Files", "文件", "檔案");
  return (
    <div className="@container h-full min-h-0">
      <div className="flex h-full min-h-0 flex-col gap-3 p-3 @xl:flex-row">
        {files === null ? (
          <div className="shrink-0 @xl:w-52"><RendererLoading /></div>
        ) : (
          <>
            <Select
              className="shrink-0 @xl:hidden"
              size="sm"
              aria-label={filesLabel}
              searchable={options.length > 8}
              options={options}
              value={selected}
              onChange={setSelected}
            />
            <nav aria-label={filesLabel} className="hidden min-h-0 w-52 shrink-0 flex-col overflow-hidden rounded-card bg-surface shadow-card @xl:flex">
              <div className="flex h-11 shrink-0 items-center justify-between border-b border-line px-4 text-[12.5px]">
                <span className="font-medium text-ink">{filesLabel}</span>
                <span className="font-mono text-[12px] text-ink-2 tabular-nums">{sorted.length}</span>
              </div>
              <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
                {sorted.map((file) => {
                  const slash = file.path.lastIndexOf("/");
                  return (
                    <li key={file.path}>
                      <button
                        type="button"
                        aria-current={file.path === selected ? "true" : undefined}
                        onClick={() => setSelected(file.path)}
                        className="flex h-8 w-full items-center gap-2 rounded-control px-2.5 text-left text-[12.5px] text-ink transition-colors duration-100 hover:bg-hover aria-[current=true]:bg-hover-2 touch:h-11"
                      >
                        <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
                          {slash >= 0 && <span className="text-ink-2">{file.path.slice(0, slash + 1)}</span>}
                          {file.path.slice(slash + 1)}
                        </span>
                        {file.path === entry && <span className="shrink-0 text-[11px] text-ink-2">{entryLabel}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>
          </>
        )}
        <div className="min-h-0 min-w-0 flex-1">{source}</div>
      </div>
    </div>
  );
}
