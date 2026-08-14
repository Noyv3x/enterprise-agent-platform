import { useEffect, useState } from "react";
import { fetchPreviewFile } from "../../data/previewActions";
import { useI18n } from "../../i18n";
import type { AgentPreviewScope, ComputerFileClue } from "../../types";
import { EmptyState } from "../common/EmptyState";
import { InlineAlert } from "../common/InlineAlert";
import { Skeleton } from "../common/Skeleton";

interface FileComputerViewProps {
  scope: AgentPreviewScope;
  file: ComputerFileClue | null;
}

export function FileComputerView({ scope, file }: FileComputerViewProps) {
  const { t } = useI18n();
  const workspacePath = file?.workspace_path || "";
  const hostTarget = String(file?.target || "sandbox").toLowerCase() === "host";
  const [content, setContent] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(!hostTarget && Boolean(workspacePath));
  const [error, setError] = useState("");

  useEffect(() => {
    if (hostTarget || !workspacePath) {
      setContent("");
      setTruncated(false);
      setLoading(false);
      setError("");
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void fetchPreviewFile(scope, workspacePath, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setContent(result.content);
        setTruncated(result.truncated);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || (cause instanceof DOMException && cause.name === "AbortError")) {
          return;
        }
        setError(cause instanceof Error ? cause.message : t("computer.file.failed"));
        setLoading(false);
      });
    return () => controller.abort();
  }, [hostTarget, scope.scope_id, scope.scope_type, t, workspacePath]);

  const path = file?.path || workspacePath;
  return (
    <section className="computer-file">
      {path ? (
        <header className="computer-file__meta">
          <span>{t("computer.file.path")}</span>
          <strong>{path}</strong>
        </header>
      ) : null}
      {hostTarget ? (
        <EmptyState
          icon="doc"
          title={t("computer.mode.file")}
          text={t("computer.file.host")}
        />
      ) : loading ? (
        <div className="computer-file__loading" role="status" aria-busy="true">
          <Skeleton width="100%" height={180} label={t("computer.file.loading")} />
        </div>
      ) : error ? (
        <InlineAlert variant="error">{error}</InlineAlert>
      ) : content ? (
        <>
          <pre className="computer-file__content">{content}</pre>
          {truncated ? <p className="computer-file__truncated">{t("computer.file.truncated")}</p> : null}
        </>
      ) : (
        <EmptyState icon="doc" title={t("computer.mode.file")} text={t("computer.file.empty")} />
      )}
    </section>
  );
}
