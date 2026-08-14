import { useState } from "react";
import { presentPreviewUrl } from "../../data/previewActions";
import { useI18n } from "../../i18n";
import type { AgentPreviewScope } from "../../types";
import { EmptyState } from "../common/EmptyState";

interface PresentComputerViewProps {
  scope: AgentPreviewScope;
}

export function PresentComputerView({ scope }: PresentComputerViewProps) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const src = presentPreviewUrl(scope);

  if (failed) {
    return (
      <EmptyState
        icon="alert"
        title={t("computer.present.title")}
        text={t("computer.present.failed")}
      />
    );
  }

  return (
    <div className="computer-present">
      <iframe
        className="computer-present__frame"
        title={t("computer.present.title")}
        src={src}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </div>
  );
}
