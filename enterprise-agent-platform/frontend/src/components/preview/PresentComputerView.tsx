import { useState } from "react";
import { presentPreviewUrl } from "../../data/previewActions";
import { useI18n } from "../../i18n";
import { cx } from "../../lib/cx";
import type { AgentPreviewScope, ComputerPresentClue } from "../../types";
import { EmptyState } from "../common/EmptyState";
import { Skeleton } from "../common/Skeleton";

interface PresentComputerViewProps {
  scope: AgentPreviewScope;
  present?: ComputerPresentClue | null;
  compact?: boolean;
}

export function PresentComputerView({ scope, present = null, compact = false }: PresentComputerViewProps) {
  const { t } = useI18n();
  const [failedKey, setFailedKey] = useState("");
  const src = presentPreviewUrl(scope);
  const status = String(present?.status || "completed").trim().toLowerCase();
  const running = !["completed", "complete", "done", "failed", "error", "cancelled"].includes(status);
  const lifecycleFailed = ["failed", "error", "cancelled"].includes(status);
  const sourceIdentity = [
    present?.workspace_path ? `workspace:${present.workspace_path}` : "",
    present?.attachment_id != null ? `attachment:${String(present.attachment_id)}` : "",
  ].filter(Boolean).join("|") || "available";
  const lifecycleRevision = String(
    present?.revision
    || [present?.tool_call_id, present?.updated_sequence ?? present?.sequence, status]
      .filter((value) => value != null && String(value) !== "")
      .join(":")
    || status,
  );
  const sourceKey = `${sourceIdentity}:${lifecycleRevision}`;
  const failed = lifecycleFailed || failedKey === sourceKey;

  if (failed) {
    return (
      <EmptyState
        icon="alert"
        title={t("computer.present.title")}
        text={t("computer.present.failed")}
      />
    );
  }

  if (running) {
    return (
      <div
        className={cx("computer-present", compact && "computer-present--compact")}
        role="status"
        aria-busy="true"
      >
        <Skeleton
          className="computer-present__skeleton"
          width="100%"
          height="100%"
          label={t("computer.loading")}
        />
      </div>
    );
  }

  return (
    <div className={cx("computer-present", compact && "computer-present--compact")}>
      <iframe
        key={sourceKey}
        className="computer-present__frame"
        title={t("computer.present.title")}
        src={src}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        tabIndex={compact ? -1 : undefined}
        onError={() => setFailedKey(sourceKey)}
      />
    </div>
  );
}
