import { Button } from "antd";
import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useI18n } from "../../i18n";
import { cx } from "../../lib/cx";
import type { AgentPreviewScope, ComputerFileClue } from "../../types";
import { EmptyState } from "../common/EmptyState";
import { InlineAlert } from "../common/InlineAlert";
import { Skeleton } from "../common/Skeleton";
import { useComputerFilePreview } from "./useComputerFilePreview";

interface FileComputerViewProps {
  scope: AgentPreviewScope;
  file: ComputerFileClue | null;
  compact?: boolean;
}

interface LineStyle extends CSSProperties {
  "--computer-line-delay": string;
}

const MAX_ANIMATED_FILE_LINES = 240;
const MAX_ANIMATED_FILE_CHARS = 24_000;
const EXPANDED_ANIMATED_CHANGE_LIMIT = 18;
const COMPACT_ANIMATED_CHANGE_LIMIT = 10;
const EXPANDED_LINE_DELAY_MS = 14;
const COMPACT_LINE_DELAY_MS = 12;
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

function unchangedLineBounds(previous: string[], current: string[]): {
  prefix: number;
  suffix: number;
} {
  let prefix = 0;
  while (
    prefix < previous.length
    && prefix < current.length
    && previous[prefix] === current[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < previous.length - prefix
    && suffix < current.length - prefix
    && previous[previous.length - 1 - suffix] === current[current.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return { prefix, suffix };
}

function stableLineKeys(lines: string[]): string[] {
  const occurrences = new Map<string, number>();
  return lines.map((line) => {
    const occurrence = occurrences.get(line) || 0;
    occurrences.set(line, occurrence + 1);
    return `${line}\u0000${occurrence}`;
  });
}

function FileSnapshot({
  content,
  previousContent,
  snapshot,
  running,
  streaming,
  compact,
}: {
  content: string;
  previousContent: string | null;
  snapshot: number;
  running: boolean;
  streaming: boolean;
  compact: boolean;
}) {
  if (streaming) {
    return (
      <pre
        className={cx("computer-file__content", compact && "computer-file__content--compact")}
        data-snapshot={snapshot}
        data-render-mode="stream"
      >
        <code className="computer-file__plain">
          {content}
          {running ? <span className="computer-file__caret" aria-hidden="true" /> : null}
        </code>
      </pre>
    );
  }

  const normalizedContent = content.replace(/\r\n?/g, "\n");
  const withinAnimatedSize = normalizedContent.length <= MAX_ANIMATED_FILE_CHARS;
  const lines = withinAnimatedSize ? normalizedContent.split("\n") : [];
  const animateLines = withinAnimatedSize && lines.length <= MAX_ANIMATED_FILE_LINES;
  const normalizedPrevious = previousContent?.replace(/\r\n?/g, "\n") || "";
  const previousLines = animateLines && normalizedPrevious.length <= MAX_ANIMATED_FILE_CHARS
    ? (previousContent === null ? [] : normalizedPrevious.split("\n"))
    : [];
  const { prefix, suffix } = previousContent === null
    ? { prefix: 0, suffix: 0 }
    : unchangedLineBounds(previousLines, lines);
  const keys = animateLines ? stableLineKeys(lines) : [];
  const animationLimit = compact
    ? COMPACT_ANIMATED_CHANGE_LIMIT
    : EXPANDED_ANIMATED_CHANGE_LIMIT;
  const lineDelay = compact ? COMPACT_LINE_DELAY_MS : EXPANDED_LINE_DELAY_MS;
  let changedOrder = 0;
  return (
    <pre
      className={cx("computer-file__content", compact && "computer-file__content--compact")}
      data-snapshot={snapshot}
      data-render-mode={animateLines ? "lines" : "plain"}
    >
      <code className={animateLines ? undefined : "computer-file__plain"}>
        {animateLines ? lines.map((line, index) => {
          const changed = previousContent === null
            || (index >= prefix && index < lines.length - suffix);
          const order = changed ? changedOrder++ : -1;
          const animated = changed && order < animationLimit;
          const className = animated
            ? previousContent === null
              ? "computer-file__line is-new"
              : "computer-file__line is-changed"
            : "computer-file__line";
          const style: LineStyle | undefined = animated ? {
            "--computer-line-delay": `${order * lineDelay}ms`,
          } : undefined;
          return (
            <span className={className} key={keys[index]} style={style}>
              {line || "\u00a0"}
            </span>
          );
        }) : content}
        {running ? <span className="computer-file__caret" aria-hidden="true" /> : null}
      </code>
    </pre>
  );
}

export function FileComputerView({ scope, file, compact = false }: FileComputerViewProps) {
  const { t } = useI18n();
  const { state, refresh, hostTarget, workspacePath, running } = useComputerFilePreview(scope, file);
  const draftStreaming = state.loaded && running && state.source === "draft";
  const progressivePhase: ProgressiveFilePhase = draftStreaming
    ? "draft"
    : completedFile(file) ? "settle" : "immediate";
  const streamIdentity = [
    scope.scope_type,
    scope.scope_id,
    workspacePath,
    file?.tool_call_id || "",
    file?.tool || "",
  ].join("\u0000");
  const progressive = useProgressiveDraftContent(state.content, progressivePhase, streamIdentity);

  const path = file?.path || workspacePath;
  const draftLabel = state.source === "draft"
    ? t(state.draftKind === "replacement"
      ? "computer.file.replacementDraft"
      : "computer.file.uncommittedDraft")
    : "";
  return (
    <section
      className={cx("computer-file", compact && "computer-file--compact")}
      aria-busy={state.loading || state.pending}
      data-source={state.loaded ? state.source : undefined}
      data-draft-kind={state.source === "draft" ? state.draftKind || undefined : undefined}
      data-revision={state.revision || undefined}
    >
      {path ? (
        <header className="computer-file__meta">
          {!compact ? <span>{t("computer.file.path")}</span> : null}
          <span className="computer-file__identity">
            <strong>{path}</strong>
            {draftLabel ? <span className="computer-file__draft-label">{draftLabel}</span> : null}
          </span>
        </header>
      ) : null}
      {hostTarget ? (
        <EmptyState
          icon="doc"
          title={t("computer.mode.file")}
          text={t("computer.file.host")}
        />
      ) : state.loaded ? (
        <>
          <FileSnapshot
            content={progressive.content}
            previousContent={state.previousContent}
            snapshot={state.snapshot}
            running={running}
            streaming={progressive.streaming}
            compact={compact}
          />
          {state.truncated && !compact ? (
            <p className="computer-file__truncated">{t("computer.file.truncated")}</p>
          ) : null}
        </>
      ) : state.loading || state.pending ? (
        <div className="computer-file__loading" role="status" aria-busy="true">
          <Skeleton width="100%" height={compact ? "100%" : 180} label={t("computer.file.loading")} />
        </div>
      ) : state.error ? (
        <InlineAlert
          className="computer-file__error"
          variant="error"
          action={compact ? undefined : (
            <Button size="small" type="link" onClick={refresh}>{t("computer.retry")}</Button>
          )}
        >
          {state.error || t("computer.file.failed")}
        </InlineAlert>
      ) : (
        <EmptyState icon="doc" title={t("computer.mode.file")} text={t("computer.file.empty")} />
      )}
    </section>
  );
}
