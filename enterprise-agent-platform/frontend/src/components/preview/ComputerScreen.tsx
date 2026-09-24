import { Button } from "antd";
import { useElapsedSeconds } from "../../hooks/useElapsedSeconds";
import { useI18n } from "../../i18n";
import type { AgentPreviewScope } from "../../types";
import { formatElapsed } from "../../utils/format";
import { ComputerPanel, LoadingState, Notice } from "../ui/fieldwork";
import { BrowserPreviewView } from "./BrowserPreviewView";
import type { ComputerSurface } from "./computer";
import { FileComputerView } from "./FileComputerView";
import { PresentComputerView } from "./PresentComputerView";
import { SearchComputerView } from "./SearchComputerView";
import { TerminalPreviewView } from "./TerminalPreviewView";

export function ComputerScreen({scope,surface,availabilityError,onRetryAvailability,browserControlRequestId}: {scope:AgentPreviewScope;surface:ComputerSurface;availabilityError:string;onRetryAvailability:()=>void;browserControlRequestId?:number}) {
  const {t}=useI18n();
  const seconds = useElapsedSeconds(surface.startedAt, surface.live && Boolean(surface.runId), surface.runId);
  const activity=t(surface.live ? "computer.pip.live" : "preview.readOnly");
  const elapsed=seconds == null ? undefined : t("computer.pip.elapsed", {time:formatElapsed(seconds)});
  return <div className="wf-computer-screen">
    {availabilityError ? <Notice tone="warning" title={availabilityError} action={<Button onClick={onRetryAvailability}>{t("computer.retry")}</Button>} /> : null}
    {surface.mode ? <ComputerPanel expanded title={t(`computer.mode.${surface.mode}`)} modeLabel={activity} elapsed={elapsed}>
    <div className="wf-computer-viewport" data-mode={surface.mode}>
      {surface.unavailable ? <Notice title={t("computer.stoppedPreview")} />
        : surface.mode === "file" ? <FileComputerView key={surface.live ? "live" : "stopped"} scope={scope} runId={surface.runId} file={surface.file} />
        : surface.mode === "browser" ? <BrowserPreviewView scope={scope} controlRequestId={browserControlRequestId} />
        : surface.mode === "terminal" ? <TerminalPreviewView scope={scope} polling={surface.terminalPolling} fallbackStep={surface.latestStep} />
        : surface.mode === "present" ? <PresentComputerView scope={scope} present={surface.present} />
        : surface.mode === "search" ? <SearchComputerView hits={surface.searchHits} />
        : null}
    </div>
    </ComputerPanel> : <div className="wf-computer-waiting">
      <div>
        {surface.unavailable ? <Notice title={t("computer.stoppedPreview")} /> : <LoadingState label={t("computer.waiting")} />}
        <div className="wf-computer-waiting-meta"><span>{activity}</span>{elapsed ? <span className="wf-mono">{elapsed}</span> : null}</div>
      </div>
    </div>}
  </div>;
}
