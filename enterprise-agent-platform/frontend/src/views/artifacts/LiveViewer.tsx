import { useRef, useState } from "react";
import { request } from "../../api";
import { Button } from "../../components/ui/beautiful/atoms/Button";
import { SegmentedControl } from "../../components/ui/beautiful/atoms/SegmentedControl";
import { StatusPill } from "../../components/ui/beautiful/atoms/StatusPill";
import { ConfirmDialog, EmptyState, Icon, Notice } from "../../components/ui/beautiful/controls";
import { FauxWindow, Ico, ScreenViewer } from "../../components/ui/beautiful/primitives/AgentScreen";
import LoadingState from "../../components/ui/beautiful/primitives/LoadingState";
import { useWords } from "../../words";
import { errorText } from "../conversation/useConversation";
import { baseName } from "./ArtifactCards";
import type { FeedbackSink, FramePick } from "./feedback";
import { frameStorageKey } from "./frameStorage";
import { KindIcon, kindLabel, previewLabel } from "./kinds";
import { AddressRow, AnnotateStrip, AnnotateToggle, EXPAND_ICON, ICON_BUTTON, PANEL_HEAD, PANEL_ROW, PANEL_SCREEN, useAnnotate } from "./toolbar";
import type { ArtifactsState } from "./useArtifacts";
import { WebFrame, type FrameWidth } from "./WebFrame";

const TONES = { waiting: "orange", running: "green", stopped: "neutral" } as const;

/** A live artifact (运行中的网站预览): the personal AI's dev server, framed at its preview path while its service runs.
 * No versions, source or download. The link stays the same across restarts: 已停止 resumes when the service starts
 * again. 停止服务 stops the service's background task; 结束预览 revokes the link (the service keeps running). Both ask
 * first. */
export function LiveViewer({ state, feedback, owner }: { state: ArtifactsState; feedback: FeedbackSink | null; owner?: number }) {
  const w = useWords();
  const { selection, artifact } = state;
  const [width, setWidth] = useState<FrameWidth>("desktop");
  const [nonce, setNonce] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState<"stop" | "end" | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const annotate = useAnnotate(feedback);
  const lastAsked = useRef<"stop" | "end">("stop");
  const id = selection?.id ?? null;
  const preview = id === null ? null : state.previewOf(id);

  const backButton = (
    <button type="button" onClick={state.back} aria-label={w("All artifacts", "全部作品", "全部作品")} title={w("All artifacts", "全部作品", "全部作品")} className={ICON_BUTTON}>
      <Icon name="chevronRight" size={15} className="rotate-180" />
    </button>
  );

  if (state.detailError && !preview) {
    return (
      <div className="flex flex-col">
        <div className={PANEL_HEAD}>{backButton}</div>
        <Notice tone="danger" className="m-3" title={w("This preview could not be opened", "无法打开这个网站预览", "無法開啟這個網站預覽")}
          action={<Button size="sm" className="touch:h-11" onClick={state.reloadDetail}>{w("Retry", "重试", "重試")}</Button>}>
          {state.detailError}
        </Notice>
      </div>
    );
  }
  if (!artifact || !preview || id === null) {
    return <div className="flex flex-1 items-center justify-center py-10"><LoadingState variant="Dots" label={w("Opening preview", "正在打开网站预览", "正在開啟網站預覽")} /></div>;
  }

  const title = artifact.title || baseName(artifact.path) || preview.service;
  const running = preview.state === "running" && !preview.revoked;
  const pageUrl = preview.base_path + preview.path.replace(/^\/+/, "");
  const widths: Record<FrameWidth, string> = { desktop: w("Desktop", "桌面", "桌面"), tablet: w("Tablet", "平板", "平板"), phone: w("Phone", "手机", "手機") };
  const annotatable = Boolean(feedback) && running;
  const inspecting = annotate.on && annotatable;
  // The runtime reports paths relative to the preview root.
  const onPick = (pick: FramePick) => annotate.add({
    feedback: { artifact_id: id, version: null, path: pick.path, kind: pick.kind, selector: pick.selector, text: pick.text, rect: pick.rect, title },
    tag: pick.tag,
    capture: { path: `/api/artifacts/${id}/live/capture`, body: { path: pick.path, rect: pick.rect, viewport: pick.viewport } },
  });

  /** 停止服务 stops the task; 结束预览 revokes the link. The stream then brings the new state; the refetch makes sure. */
  const act = async () => {
    const action = confirming;
    if (!action || (action === "stop" && !preview.task_id)) return;
    setBusy(true);
    setActionError("");
    try {
      if (action === "stop") await request(`/api/tasks/${encodeURIComponent(preview.task_id!)}/stop`, { method: "POST", body: "{}" });
      else await request(`/api/artifacts/${id}/live`, { method: "DELETE" });
      setConfirming(null);
      state.refreshDetail();
    } catch (reason) {
      setActionError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  const ask = (action: "stop" | "end") => {
    setActionError("");
    setConfirming(action);
  };
  // The dialog keeps its words while it closes.
  const asked = confirming ?? lastAsked.current;
  lastAsked.current = asked;

  const page = (key?: string) => (
    <WebFrame key={key} src={pageUrl} title={title} width={width} inspecting={inspecting} onPick={onPick}
      onInspectExit={() => annotate.setOn(false)} storageKey={frameStorageKey(owner, id)} />
  );
  let body;
  if (running) {
    body = expanded ? null : page(`${id}:${nonce}`);
  } else if (preview.state === "waiting") {
    body = (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
        <LoadingState variant="Dots" label={w("Waiting for the service to start", "等待服务启动", "等待服務啟動")} />
        <p className="max-w-[44ch] text-[12px] leading-[1.45] text-ink-2">
          {w(`The site opens here once ${preview.service} is running.`, `${preview.service} 启动后，网站会在这里打开。`, `${preview.service} 啟動後，網站會在這裡開啟。`)}
        </p>
      </div>
    );
  } else if (preview.revoked) {
    body = (
      <EmptyState
        className="absolute inset-0"
        icon="close"
        title={w("This preview has ended", "预览已结束", "預覽已結束")}
        description={w(
          "Its link no longer works. Ask the AI to preview the site again when you need it.",
          "它的链接已失效。需要时，让 AI 重新创建预览。",
          "它的連結已失效。需要時，讓 AI 重新建立預覽。",
        )}
      />
    );
  } else {
    body = (
      <EmptyState
        className="absolute inset-0"
        icon="stop"
        title={w("The service has stopped", "服务已停止", "服務已停止")}
        description={w(
          `The site shows here again, at the same link, once the AI starts ${preview.service} again.`,
          `AI 重新启动 ${preview.service} 后，网站会在这里继续显示，链接不变。`,
          `AI 重新啟動 ${preview.service} 後，網站會在這裡繼續顯示，連結不變。`,
        )}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={PANEL_HEAD}>
        {backButton}
        <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-control bg-accent-tint text-accent-ink">
          <KindIcon kind="live" size={14} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="truncate text-[13px] font-semibold text-ink" title={title}>{title}</h3>
          <span className="truncate text-[12px] text-ink-2">{[kindLabel("live", w), preview.service].filter(Boolean).join(" · ")}</span>
        </div>
        <StatusPill tone={preview.revoked ? "neutral" : TONES[preview.state]} className="h-6 shrink-0 text-[12px]">{previewLabel(preview, w)}</StatusPill>
        <div className="flex shrink-0 items-center gap-0.5">
          <button type="button" aria-label={w("Refresh", "刷新", "重新整理")} title={w("Refresh", "刷新", "重新整理")} aria-disabled={!running || undefined}
            className={ICON_BUTTON} onClick={() => setNonce((value) => value + 1)}>
            <Icon name="refresh" size={14} />
          </button>
          <a href={running ? pageUrl : undefined} target="_blank" rel="noopener noreferrer" aria-disabled={!running || undefined}
            aria-label={w("Open in new tab", "新标签打开", "在新分頁開啟")} title={w("Open in new tab", "新标签打开", "在新分頁開啟")} className={ICON_BUTTON}>
            <Icon name="external" size={14} />
          </a>
          {running && (
            <button type="button" aria-label={w("Enlarge", "放大", "放大")} title={w("Enlarge", "放大", "放大")} onClick={() => setExpanded(true)} className={ICON_BUTTON}>
              <Ico size={13} path={EXPAND_ICON} />
            </button>
          )}
        </div>
      </div>

      {!preview.revoked && <div className={PANEL_ROW}>
        {running && (
          <SegmentedControl
            options={[widths.desktop, widths.tablet, widths.phone]}
            value={widths[width]}
            onChange={(label) => setWidth((Object.keys(widths) as FrameWidth[]).find((key) => widths[key] === label) ?? "desktop")}
            className="shrink-0 touch:h-11"
          />
        )}
        {annotatable && <AnnotateToggle on={annotate.on} onChange={annotate.setOn} />}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {running && preview.task_id && (
            <Button variant="quiet" size="xs" onClick={() => ask("stop")} className="text-red-ink touch:h-11">
              <Icon name="stop" size={13} />
              {w("Stop service", "停止服务", "停止服務")}
            </Button>
          )}
          {!preview.revoked && (
            <Button variant="quiet" size="xs" onClick={() => ask("end")} className="text-ink-2 touch:h-11">
              <Icon name="close" size={13} />
              {w("End preview", "结束预览", "結束預覽")}
            </Button>
          )}
        </div>
      </div>}

      {inspecting && feedback && <AnnotateStrip page feedback={feedback} note={annotate.note} onDone={() => annotate.setOn(false)} />}

      <AddressRow address={pageUrl} />

      <section aria-label={title} className={PANEL_SCREEN}>
        <div className="absolute inset-0 flex flex-col">{body}</div>
      </section>

      {expanded && running && (
        <ScreenViewer title={title} collapseLabel={w("Collapse", "收起", "收起")} onClose={() => setExpanded(false)}>
          <div className="relative overflow-hidden" style={{ width: "min(1280px, 92vw)", height: "calc(100vh - 120px)" }}>
            <FauxWindow tabs={[{ id: "live", label: title }]} address={pageUrl}>{page()}</FauxWindow>
          </div>
        </ScreenViewer>
      )}

      <ConfirmDialog
        open={confirming !== null}
        tone="danger"
        title={asked === "end" ? w("End this preview?", "结束预览？", "結束預覽？") : w("Stop this service?", "停止服务？", "停止服務？")}
        description={asked === "end" ? w(
          `The link will stop working, also in tabs already open. ${preview.service} keeps running; the AI can preview it again later with a new link.`,
          `链接将失效，已打开的页面也无法再访问。${preview.service} 会继续运行，之后可以让 AI 重新创建预览（链接会变）。`,
          `連結將失效，已開啟的頁面也無法再存取。${preview.service} 會繼續執行，之後可以讓 AI 重新建立預覽（連結會變）。`,
        ) : w(
          `The background service ${preview.service} stops and the preview pauses. It resumes at the same link when the AI starts the service again.`,
          `后台服务 ${preview.service} 将停止，预览随之暂停。AI 再次启动服务后，预览会以同一链接恢复。`,
          `背景服務 ${preview.service} 將停止，預覽隨之暫停。AI 再次啟動服務後，預覽會以同一連結恢復。`,
        )}
        confirmLabel={asked === "end" ? w("End preview", "结束预览", "結束預覽") : w("Stop service", "停止服务", "停止服務")}
        cancelLabel={asked === "end" ? w("Keep preview", "保留预览", "保留預覽") : w("Keep running", "继续运行", "繼續執行")}
        busy={busy}
        error={actionError || undefined}
        onConfirm={() => void act()}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}
