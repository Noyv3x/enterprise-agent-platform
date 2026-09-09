import { Button } from "antd";
import { useLayoutEffect, useRef, useState } from "react";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useI18n } from "../../i18n";
import type { AgentPreviewScope, ComputerFileClue } from "../../types";
import { ComputerOutput, EmptyState, LoadingState, Notice } from "../ui/fieldwork";
import { useComputerFilePreview } from "./useComputerFilePreview";

const STREAM_FRAME_MS = 32;
const STREAM_MIN_CHUNK_CHARS = 24;
const STREAM_TARGET_FRAMES = 18;

type ProgressiveFilePhase = "draft" | "settle" | "immediate";

function safeSliceEnd(content: string, end: number): number {
  if (end <= 0 || end >= content.length) return end;
  const preceding = content.charCodeAt(end - 1);
  const following = content.charCodeAt(end);
  return preceding >= 0xd800 && preceding <= 0xdbff && following >= 0xdc00 && following <= 0xdfff
    ? end + 1
    : end;
}

function useProgressiveDraftContent(
  content: string,
  phase: ProgressiveFilePhase,
  identity: string,
): { content: string; streaming: boolean } {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [view, setView] = useState({ content, streamIdentity: "" });
  const displayedRef = useRef(content);
  const streamIdentityRef = useRef("");
  const authorityRef = useRef({ phase, identity, content });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const previous = authorityRef.current;
    authorityRef.current = { phase, identity, content };
    const appendOnly = content.startsWith(previous.content)
      && content.startsWith(displayedRef.current);
    const firstVisibleDraft = previous.phase !== "draft"
      && previous.content.length === 0
      && displayedRef.current.length === 0;
    const sameLifecycle = previous.identity === identity
      && (previous.phase === "draft" || previous.phase === "settle");
    const canStream = (phase === "draft" || phase === "settle")
      && !reducedMotion
      && appendOnly
      && (
        (phase === "draft" && (sameLifecycle || firstVisibleDraft))
        || (phase === "settle" && sameLifecycle && streamIdentityRef.current === identity)
      );

    const updateView = (nextContent: string, streamIdentity: string) => {
      displayedRef.current = nextContent;
      streamIdentityRef.current = streamIdentity;
      setView((current) => (
        current.content === nextContent && current.streamIdentity === streamIdentity
          ? current
          : { content: nextContent, streamIdentity }
      ));
    };

    if (!canStream) {
      updateView(content, phase === "draft" ? identity : "");
      return;
    }

    streamIdentityRef.current = identity;
    setView((current) => current.streamIdentity === identity
      ? current
      : { ...current, streamIdentity: identity });
    if (displayedRef.current === content) return;

    const remainingAtStart = content.length - displayedRef.current.length;
    const chunkSize = Math.max(
      STREAM_MIN_CHUNK_CHARS,
      Math.ceil(remainingAtStart / STREAM_TARGET_FRAMES),
    );

    const tick = () => {
      const current = displayedRef.current;
      if (!content.startsWith(current)) {
        updateView(content, "");
        timerRef.current = null;
        return;
      }
      const end = safeSliceEnd(content, Math.min(content.length, current.length + chunkSize));
      const next = content.slice(0, end);
      updateView(next, identity);
      if (next.length < content.length) {
        timerRef.current = setTimeout(tick, STREAM_FRAME_MS);
      } else {
        timerRef.current = null;
      }
    };

    tick();
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [content, identity, phase, reducedMotion]);

  return {
    content: view.content,
    streaming: phase === "draft"
      || (phase === "settle" && view.streamIdentity === identity),
  };
}

function completedFile(file: ComputerFileClue | null): boolean {
  const status = String(file?.status || "").trim().toLowerCase();
  return ["completed", "complete", "done"].includes(status);
}

function FileText({content, previous, streaming, running}: {content:string; previous:string|null; streaming:boolean; running:boolean}) {
  const lines = !streaming && content.length <= 24_000 ? content.replace(/\r\n?/g, "\n").split("\n") : [];
  const previousLines = previous?.replace(/\r\n?/g, "\n").split("\n") || [];
  const bounded = lines.length > 0 && lines.length <= 240;
  return <pre className="wf-file-text" aria-label="" data-render-mode={streaming ? "stream" : bounded ? "lines" : "plain"}><code>
    {bounded ? lines.map((line,index) => <span className="wf-file-line" key={index} data-changed={previous !== null && previousLines[index] !== line || undefined}>{line || "\u00a0"}</span>) : content}
    {running ? <span className="wf-file-caret" aria-hidden="true" /> : null}
  </code></pre>;
}

export function FileComputerView({scope,runId,file,compact=false}: {scope:AgentPreviewScope;runId:string;file:ComputerFileClue|null;compact?:boolean}) {
  const {t}=useI18n();
  const {state,refresh,hostTarget,workspacePath,running}=useComputerFilePreview(scope,runId,file);
  const phase: ProgressiveFilePhase = state.loaded && running && state.source === "draft" ? "draft" : completedFile(file) ? "settle" : "immediate";
  const identity=[runId,scope.scope_type,scope.scope_id,workspacePath,file?.tool_call_id || "",file?.tool || ""].join("\u0000");
  const progressive=useProgressiveDraftContent(state.content,phase,identity);
  const draftLabel=state.source === "draft" ? t(state.draftKind === "replacement" ? "computer.file.replacementDraft" : "computer.file.uncommittedDraft") : "";
  return <section className="wf-file-view" data-compact={compact || undefined} aria-busy={state.loading || state.pending} data-source={state.loaded ? state.source : undefined} data-draft-kind={state.source === "draft" ? state.draftKind || undefined : undefined} data-revision={state.revision || undefined}>
    <ComputerOutput kind="file" title={file?.path || workspacePath || t("computer.mode.file")} meta={draftLabel || t("preview.readOnly")} truncated={state.truncated ? t("computer.file.truncated") : undefined}>
      {hostTarget ? <EmptyState compact title={t("computer.mode.file")} description={t("computer.file.host")} />
        : state.loaded ? <FileText content={progressive.content} previous={state.previousContent} streaming={progressive.streaming} running={running} />
        : state.loading || state.pending ? <div aria-busy="true"><LoadingState label={t("computer.file.loading")} /></div>
        : state.error ? <Notice tone="danger" title={state.error} action={!compact ? <Button onClick={refresh}>{t("computer.retry")}</Button> : undefined} />
        : <EmptyState compact title={t("computer.mode.file")} description={t("computer.file.empty")} />}
    </ComputerOutput>
    {state.loaded && state.error ? <Notice tone="warning" title={state.error} action={!compact ? <Button onClick={refresh}>{t("computer.retry")}</Button> : undefined} /> : null}
  </section>;
}
