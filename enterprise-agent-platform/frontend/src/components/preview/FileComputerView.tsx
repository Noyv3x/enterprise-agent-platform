import { Button } from "antd";
import type { CSSProperties } from "react";
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

function FileSnapshot({
  content,
  previousContent,
  snapshot,
  running,
  compact,
}: {
  content: string;
  previousContent: string | null;
  snapshot: number;
  running: boolean;
  compact: boolean;
}) {
  const normalizedContent = content.replace(/\r\n?/g, "\n");
  const withinAnimatedSize = normalizedContent.length <= MAX_ANIMATED_FILE_CHARS;
  const lines = withinAnimatedSize ? normalizedContent.split("\n") : [];
  const animateLines = withinAnimatedSize && lines.length <= MAX_ANIMATED_FILE_LINES;
  const previousLines = animateLines
    ? previousContent?.replace(/\r\n?/g, "\n").split("\n") || []
    : [];
  return (
    <pre
      className={cx("computer-file__content", compact && "computer-file__content--compact")}
      data-snapshot={snapshot}
      data-render-mode={animateLines ? "lines" : "plain"}
    >
      <code className={animateLines ? undefined : "computer-file__plain"}>
        {animateLines ? lines.map((line, index) => {
          const changed = previousContent === null || previousLines[index] !== line;
          const className = previousContent === null
            ? "computer-file__line is-new"
            : changed ? "computer-file__line is-changed" : "computer-file__line";
          const style: LineStyle = {
            "--computer-line-delay": `${Math.min(index, compact ? 10 : 28) * (compact ? 18 : 24)}ms`,
          };
          return (
            <span className={className} key={`${snapshot}:${index}`} style={style}>
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

  const path = file?.path || workspacePath;
  return (
    <section
      className={cx("computer-file", compact && "computer-file--compact")}
      aria-busy={state.loading || state.pending}
    >
      {path ? (
        <header className="computer-file__meta">
          {!compact ? <span>{t("computer.file.path")}</span> : null}
          <strong>{path}</strong>
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
            content={state.content}
            previousContent={state.previousContent}
            snapshot={state.snapshot}
            running={running}
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
