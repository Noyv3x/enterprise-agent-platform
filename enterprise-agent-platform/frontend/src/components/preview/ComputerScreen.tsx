import { Button } from "antd";
import { useI18n } from "../../i18n";
import type { AgentPreviewScope, ActivityStep } from "../../types";
import { InlineAlert } from "../common/InlineAlert";
import { BrowserPreviewView } from "./BrowserPreviewView";
import type { ComputerSurface } from "./computer";
import { FileComputerView } from "./FileComputerView";
import { PresentComputerView } from "./PresentComputerView";
import { SearchComputerView } from "./SearchComputerView";
import { TerminalPreviewView } from "./TerminalPreviewView";

interface ComputerScreenProps {
  scope: AgentPreviewScope;
  surface: ComputerSurface;
  availabilityError: string;
  onRetryAvailability: () => void;
  latestTerminalStep?: ActivityStep | null;
  browserControlRequestId?: number;
}

export function ComputerScreen({
  scope,
  surface,
  availabilityError,
  onRetryAvailability,
  latestTerminalStep,
  browserControlRequestId,
}: ComputerScreenProps) {
  const { t } = useI18n();

  return (
    <div className="computer-screen">
      {availabilityError ? (
        <InlineAlert
          variant="warning"
          action={(
            <Button size="small" type="link" onClick={onRetryAvailability}>
              {t("computer.retry")}
            </Button>
          )}
        >
          {availabilityError}
        </InlineAlert>
      ) : null}
      {surface.mode === "file" ? <FileComputerView scope={scope} file={surface.file} /> : null}
      {surface.mode === "search" ? <SearchComputerView hits={surface.searchHits} /> : null}
      {surface.mode === "present" ? <PresentComputerView scope={scope} present={surface.present} /> : null}
      {surface.mode === "browser" ? (
        <BrowserPreviewView
          scope={scope}
          controlRequestId={browserControlRequestId}
        />
      ) : null}
      {surface.mode === "terminal" ? (
        <div className="computer-terminal">
          <TerminalPreviewView scope={scope} fallbackStep={latestTerminalStep} />
        </div>
      ) : null}
    </div>
  );
}
