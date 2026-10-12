import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { request, type ArtifactFile, type ArtifactSource, type ArtifactVersion, type ArtifactView } from "../../api";
import { Button } from "../../components/ui/beautiful/atoms/Button";
import { SegmentedControl } from "../../components/ui/beautiful/atoms/SegmentedControl";
import { EmptyState, Icon, Notice, Select } from "../../components/ui/beautiful/controls";
import { FauxWindow, Ico, ScreenViewer } from "../../components/ui/beautiful/primitives/AgentScreen";
import LoadingState from "../../components/ui/beautiful/primitives/LoadingState";
import { intlLocale } from "../../i18n";
import { useWords } from "../../words";
import { baseName } from "./ArtifactCards";
import type { FeedbackSink, FramePick } from "./feedback";
import { frameStorageKey } from "./frameStorage";
import { KindIcon, kindLabel, previewLabel } from "./kinds";
import { LiveViewer } from "./LiveViewer";
import { QuoteLayer } from "./QuoteLayer";
import { ArtifactDiff, ArtifactPreview, ArtifactSourceView } from "./renderers";
import { ANNOTATABLE, AnnotateStrip, AnnotateToggle, EXPAND_ICON, ICON_BUTTON, useAnnotate } from "./toolbar";
import { TEXT_KINDS, type ArtifactRendererProps } from "./types";
import type { ArtifactsState } from "./useArtifacts";
import { useViewUrl } from "./useViewUrl";
import { WebFrame, type FrameWidth } from "./WebFrame";

type Mode = "preview" | "source" | "diff";

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(intlLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** The 作品 panel's content: the conversation's artifacts, or the open one with its toolbar and preview. `feedback`
 * (null when the person cannot post) enables 圈选; `owner` keys the pages' kept storage per account. */
export function ArtifactPanel({ state, feedback = null, owner }: { state: ArtifactsState; feedback?: FeedbackSink | null; owner?: number }) {
  if (!state.selection) return <ArtifactList state={state} />;
  return state.artifact?.kind === "live"
    ? <LiveViewer state={state} feedback={feedback} owner={owner} />
    : <ArtifactViewer state={state} feedback={feedback} owner={owner} />;
}

function ArtifactList({ state }: { state: ArtifactsState }) {
  const w = useWords();
  const { list, listError } = state;
  if (list === null && listError) {
    return (
      <Notice tone="danger" title={w("Artifacts could not be loaded", "无法加载作品", "無法載入作品")}
        action={<Button size="sm" className="touch:h-11" onClick={() => void state.reloadList()}>{w("Retry", "重试", "重試")}</Button>}>
        {listError}
      </Notice>
    );
  }
  if (list === null) {
    return <div className="flex flex-1 items-center justify-center py-10"><LoadingState variant="Dots" label={w("Loading artifacts", "正在加载作品", "正在載入作品")} /></div>;
  }
  if (!list.length) {
    return (
      <EmptyState
        className="flex-1"
        icon={<KindIcon kind="web" />}
        title={w("No artifacts yet", "还没有作品", "還沒有作品")}
        description={w(
          "Ask the AI for a report, a web page, a diagram or a table. What it publishes opens here, with every version kept.",
          "让 AI 写一份报告、做一个网页、画一张图或整理一张表，发布的作品会在这里打开，并保留每个版本。",
          "讓 AI 寫一份報告、做一個網頁、畫一張圖或整理一張表，發佈的作品會在這裡開啟，並保留每個版本。",
        )}
      />
    );
  }
  return (
    <ul aria-label={w("Artifacts in this conversation", "本对话的作品", "本對話的作品")} className="-mx-1.5 flex flex-col gap-0.5">
      {list.map((artifact) => (
        <li key={artifact.id}>
          <button
            type="button"
            onClick={() => state.open(artifact.id, artifact.latest_version)}
            className="flex min-h-12 w-full min-w-0 items-center gap-3 rounded-control px-1.5 py-1.5 text-left transition-colors duration-100 hover:bg-hover touch:min-h-14"
          >
            <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-control bg-accent-tint text-accent-ink shadow-hairline">
              <KindIcon kind={artifact.kind} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-ink">{artifact.title || baseName(artifact.path)}</span>
              <span className="truncate text-[12px] text-ink-2 tabular-nums">
                {(artifact.kind === "live"
                  ? [kindLabel(artifact.kind, w), previewLabel(state.previewOf(artifact.id), w)]
                  : [`v${artifact.latest_version}`, kindLabel(artifact.kind, w), when(artifact.updated_at)]).filter(Boolean).join(" · ")}
              </span>
            </span>
            <Icon name="chevronRight" size={14} className="shrink-0 text-ink-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Source text per file of one version. Versions are immutable, so the open panel caches it (per panel, never across
 * accounts); a failure is not cached, so the renderer's retry asks again. */
type SourceCache = Map<string, Promise<ArtifactSource>>;

function sourceLoader(sources: SourceCache, id: number, version: number, entry: string): (path?: string) => Promise<ArtifactSource> {
  return (path = entry) => {
    const key = `${id}:${version}:${path}`;
    let pending = sources.get(key);
    if (!pending) {
      pending = request<ArtifactSource>(`/api/artifacts/${id}/versions/${version}/source?path=${encodeURIComponent(path)}`);
      pending.catch(() => sources.delete(key));
      sources.set(key, pending);
    }
    return pending;
  };
}

function ArtifactViewer({ state, feedback, owner }: { state: ArtifactsState; feedback: FeedbackSink | null; owner?: number }) {
  const w = useWords();
  const { selection, artifact, versions, notice } = state;
  const [mode, setMode] = useState<Mode>("preview");
  const [width, setWidth] = useState<FrameWidth>("desktop");
  const [nonce, setNonce] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const annotate = useAnnotate(feedback);
  const sources = useRef<SourceCache>(new Map()).current;
  const id = selection?.id ?? null;
  const version = selection?.version ?? null;
  const current = versions.find((item) => item.version === version);
  const view = useViewUrl(current ? id : null, current ? version : null, nonce);

  const backButton = (
    <button type="button" onClick={state.back} aria-label={w("All artifacts", "全部作品", "全部作品")} title={w("All artifacts", "全部作品", "全部作品")} className={ICON_BUTTON}>
      <Icon name="chevronRight" size={15} className="rotate-180" />
    </button>
  );

  if (state.detailError && !current) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center">{backButton}</div>
        <Notice tone="danger" title={w("This artifact could not be opened", "无法打开这个作品", "無法開啟這個作品")}
          action={<Button size="sm" className="touch:h-11" onClick={state.reloadDetail}>{w("Retry", "重试", "重試")}</Button>}>
          {state.detailError}
        </Notice>
      </div>
    );
  }
  if (!artifact || !current || id === null || version === null) {
    return <div className="flex flex-1 items-center justify-center py-10"><LoadingState variant="Dots" label={w("Opening artifact", "正在打开作品", "正在開啟作品")} /></div>;
  }

  const title = artifact.title || baseName(artifact.path);
  const web = artifact.kind === "web" || artifact.kind === "site";
  const annotatable = feedback && mode === "preview" ? ANNOTATABLE[artifact.kind] : undefined;
  const annotating = annotate.on && Boolean(annotatable);
  const frame: FrameAnnotation = {
    inspecting: annotating && annotatable === "page",
    quoting: annotating && annotatable === "text",
    onPick: (pick) => annotate.add({
      feedback: { artifact_id: id, version, path: pick.path, kind: pick.kind, selector: pick.selector, text: pick.text, rect: pick.rect, title },
      tag: pick.tag,
      capture: { path: `/api/artifacts/${id}/versions/${version}/capture`, body: { path: pick.path, rect: pick.rect, viewport: pick.viewport } },
    }),
    onInspectExit: () => annotate.setOn(false),
    onQuote: (text) => annotate.add({ feedback: { artifact_id: id, version, path: current.entry, kind: "quote", text, title } }),
    storageKey: frameStorageKey(owner, id),
  };
  const previous = versions.find((item) => item.version < version);
  const diffable = Boolean(TEXT_KINDS[artifact.kind]) && Boolean(previous);
  const shownMode: Mode = mode === "diff" && !diffable ? "source" : mode;
  const modes = { preview: w("Preview", "预览", "預覽"), source: w("Source", "源码", "原始碼") };
  const widths: Record<FrameWidth, string> = { desktop: w("Desktop", "桌面", "桌面"), tablet: w("Tablet", "平板", "平板"), phone: w("Phone", "手机", "手機") };
  const latest = versions[0]?.version ?? version;
  const download = `/api/artifacts/${id}/versions/${version}/download`;

  const versionOptions = versions.map((item) => ({
    value: String(item.version),
    label: [`v${item.version}`, when(item.created_at), item.version === latest ? w("Latest", "最新", "最新") : ""].filter(Boolean).join(" · "),
  }));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {backButton}
        <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-control bg-accent-tint text-accent-ink">
          <KindIcon kind={artifact.kind} size={14} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="truncate text-[13px] font-semibold text-ink" title={title}>{title}</h3>
          <span className="truncate text-[12px] text-ink-2">{kindLabel(artifact.kind, w)}</span>
        </div>
        <Select<string>
          aria-label={w("Version", "版本", "版本")}
          size="sm"
          className="w-auto max-w-[13.5rem] shrink-0 max-sm:w-full max-sm:max-w-none"
          value={String(version)}
          options={versionOptions}
          onChange={(value) => state.chooseVersion(Number(value))}
        />
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <SegmentedControl
          options={[modes.preview, modes.source]}
          value={shownMode === "preview" ? modes.preview : modes.source}
          onChange={(label) => setMode(label === modes.preview ? "preview" : "source")}
          className="shrink-0 touch:h-11"
        />
        {diffable && (
          <Button variant="quiet" size="xs" aria-pressed={shownMode === "diff"} onClick={() => setMode(shownMode === "diff" ? "source" : "diff")}
            className={`touch:h-11 ${shownMode === "diff" ? "bg-hover-2" : "text-ink-2"}`}>
            {w("Compare with previous", "对比上一版", "比較上一版")}
          </Button>
        )}
        {web && shownMode === "preview" && (
          <SegmentedControl
            options={[widths.desktop, widths.tablet, widths.phone]}
            value={widths[width]}
            onChange={(label) => setWidth((Object.keys(widths) as FrameWidth[]).find((key) => widths[key] === label) ?? "desktop")}
            className="shrink-0 touch:h-11"
          />
        )}
        {annotatable && <AnnotateToggle on={annotate.on} onChange={annotate.setOn} />}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <button type="button" aria-label={w("Refresh", "刷新", "重新整理")} title={w("Refresh", "刷新", "重新整理")} className={ICON_BUTTON} onClick={() => setNonce((value) => value + 1)}>
            <Icon name="refresh" size={14} />
          </button>
          <a href={view.url ?? undefined} target="_blank" rel="noopener noreferrer" aria-disabled={!view.url || undefined}
            aria-label={w("Open in new tab", "新标签打开", "在新分頁開啟")} title={w("Open in new tab", "新标签打开", "在新分頁開啟")} className={ICON_BUTTON}>
            <Icon name="external" size={14} />
          </a>
          <a href={download} download aria-label={w(`Download v${version}`, `下载 v${version}`, `下載 v${version}`)} title={w("Download", "下载", "下載")} className={ICON_BUTTON}>
            <Icon name="download" size={14} />
          </a>
        </div>
      </div>

      {annotating && feedback && <AnnotateStrip page={annotatable === "page"} feedback={feedback} note={annotate.note} onDone={() => annotate.setOn(false)} />}

      <div role="status" aria-live="polite" aria-label={w("Version updates", "版本更新", "版本更新")} className="empty:hidden">
        {notice?.type === "updated" && notice.version === version && (
          <span key={notice.seq} className="inline-flex h-6 items-center gap-1.5 rounded-full bg-green-tint px-2.5 text-[12px] font-medium text-ink" style={{ animation: "fade-in 200ms ease-out both" }}>
            <Icon name="check" size={12} className="text-green-ink" />
            {w(`Updated to v${notice.version}`, `已更新到 v${notice.version}`, `已更新到 v${notice.version}`)}
          </span>
        )}
        {notice?.type === "newer" && notice.version > version && (
          <div key={notice.seq} className="flex min-h-9 items-center gap-2 rounded-card bg-accent-tint py-1 pr-1 pl-3 text-[12.5px] text-ink" style={{ animation: "fade-in 200ms ease-out both" }}>
            <Icon name="info" size={14} className="shrink-0 text-accent-ink" />
            <span className="min-w-0 flex-1">{w(`A newer version v${notice.version} is available`, `有新版本 v${notice.version}`, `有新版本 v${notice.version}`)}</span>
            <Button size="xs" className="touch:h-11" onClick={() => state.chooseVersion(notice.version)}>{w("View", "查看", "檢視")}</Button>
          </div>
        )}
      </div>

      <section
        aria-label={w(`${title}, v${version}`, `${title}，v${version}`, `${title}，v${version}`)}
        className="relative flex min-h-[320px] flex-1 flex-col overflow-hidden rounded-window bg-surface shadow-card"
      >
        <FauxWindow
          tabs={[{ id: "artifact", label: `${title} · v${version}` }]}
          address={web ? artifact.path : null}
          actions={
            <button type="button" aria-label={w("Enlarge", "放大", "放大")} title={w("Enlarge", "放大", "放大")} onClick={() => setExpanded(true)}
              className="primitive-icon-button size-6 text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink touch:size-11">
              <Ico size={13} path={EXPAND_ICON} />
            </button>
          }
        >
          {expanded ? null : (
            <ArtifactBody key={`${id}:${version}:${nonce}`} sources={sources} artifact={artifact} current={current} previous={previous} mode={shownMode} width={width} viewUrl={view.url} viewError={view.error} frame={frame} />
          )}
        </FauxWindow>
      </section>

      {expanded && (
        <ScreenViewer title={`${title} · v${version}`} collapseLabel={w("Collapse", "收起", "收起")} onClose={() => setExpanded(false)}>
          <div className="relative overflow-hidden" style={{ width: "min(1280px, 92vw)", height: "calc(100vh - 120px)" }}>
            <FauxWindow tabs={[{ id: "artifact", label: title }]} address={web ? artifact.path : null}>
              <ArtifactBody sources={sources} artifact={artifact} current={current} previous={previous} mode={shownMode} width={width} viewUrl={view.url} viewError={view.error} frame={frame} />
            </FauxWindow>
          </div>
        </ScreenViewer>
      )}
    </div>
  );
}

/** What 圈选 needs from the preview: the page inspector or text quoting, and the page's kept storage. */
interface FrameAnnotation {
  inspecting: boolean;
  quoting: boolean;
  onPick: (pick: FramePick) => void;
  onInspectExit: () => void;
  onQuote: (text: string) => void;
  storageKey: string;
}

/** One version in the chosen mode: the web frame or a kind renderer, the source, or the diff with the previous version. */
function ArtifactBody({ sources, artifact, current, previous, mode, width, viewUrl, viewError, frame }: {
  sources: SourceCache;
  artifact: ArtifactView;
  current: ArtifactVersion;
  previous: ArtifactVersion | undefined;
  mode: Mode;
  width: FrameWidth;
  viewUrl: string | null;
  viewError: string;
  frame: FrameAnnotation;
}) {
  const w = useWords();
  const { version, entry } = current;
  const loadSource = useMemo(() => sourceLoader(sources, artifact.id, version, entry), [sources, artifact.id, version, entry]);
  const loadPreviousSource = useMemo(() => (previous ? sourceLoader(sources, artifact.id, previous.version, previous.entry) : null), [sources, artifact.id, previous]);
  const files = useFiles(artifact.id, version, mode === "source");
  const props: ArtifactRendererProps = { artifact, version, entry, viewUrl, loadSource };

  let body: ReactNode;
  if (mode === "diff" && previous && loadPreviousSource) {
    body = <ArtifactDiff artifact={artifact} version={version} previousVersion={previous.version} loadSource={loadSource} loadPreviousSource={loadPreviousSource} />;
  } else if (mode === "source" || mode === "diff") {
    body = <ArtifactSourceView {...props} files={files} />;
  } else if (viewError && (artifact.kind === "web" || artifact.kind === "site")) {
    body = (
      <div className="absolute inset-0 overflow-auto p-4">
        <Notice tone="danger" title={w("The page could not be opened", "无法打开页面", "無法開啟頁面")}>{viewError}</Notice>
      </div>
    );
  } else if (artifact.kind === "web" || artifact.kind === "site") {
    body = (
      <WebFrame src={viewUrl} title={artifact.title || baseName(artifact.path)} width={width} inspecting={frame.inspecting}
        onPick={frame.onPick} onInspectExit={frame.onInspectExit} storageKey={frame.storageKey} />
    );
  } else if (ANNOTATABLE[artifact.kind] === "text") {
    body = <QuoteLayer active={frame.quoting} onQuote={frame.onQuote}><ArtifactPreview {...props} /></QuoteLayer>;
  } else {
    body = <ArtifactPreview {...props} />;
  }
  return <div className="absolute inset-0 flex flex-col">{body}</div>;
}

/** The version's file list, for the source view's site browser; null while it loads. */
function useFiles(id: number, version: number, wanted: boolean): ArtifactFile[] | null {
  const [files, setFiles] = useState<ArtifactFile[] | null>(null);
  const requested = useRef(false);
  useEffect(() => {
    if (!wanted || requested.current) return;
    requested.current = true;
    request<{ entry: string; files: ArtifactFile[] }>(`/api/artifacts/${id}/versions/${version}/files`).then(
      (result) => setFiles(result.files),
      // Without the list the source view still shows the entry.
      () => setFiles([]),
    );
  }, [id, version, wanted]);
  return files;
}
