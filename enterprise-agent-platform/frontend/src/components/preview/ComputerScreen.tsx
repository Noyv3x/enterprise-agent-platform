import { Button } from "antd";
import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import type { ActivityStep, AgentPreviewScope } from "../../types";
import { ComputerPanel, LoadingState, Notice } from "../ui/fieldwork";
import { BrowserPreviewView } from "./BrowserPreviewView";
import type { ComputerSurface } from "./computer";
import { FileComputerView } from "./FileComputerView";
import { PresentComputerView } from "./PresentComputerView";
import { SearchComputerView } from "./SearchComputerView";
import { TerminalPreviewView } from "./TerminalPreviewView";
import { formatComputerElapsed } from "./ComputerPip";

export function ComputerScreen({scope,surface,availabilityError,onRetryAvailability,latestTerminalStep,browserControlRequestId}: {scope:AgentPreviewScope;surface:ComputerSurface;availabilityError:string;onRetryAvailability:()=>void;latestTerminalStep?:ActivityStep|null;browserControlRequestId?:number}) {
  const {t}=useI18n();
  const [now, setNow] = useState(Date.now);
  const timing = surface.live && Boolean(surface.runId) && surface.startedAt != null && surface.startedAt > 0;
  useEffect(() => {
    if (!timing) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [timing, surface.runId, surface.startedAt]);
  const activity=t(surface.live ? "computer.pip.live" : "preview.readOnly");
  const elapsed=timing ? t("computer.pip.elapsed", {time:formatComputerElapsed((now-Number(surface.startedAt)*1000)/1000)}) : undefined;
  return <div className="wf-computer-screen">
    {availabilityError ? <Notice tone="warning" title={availabilityError} action={<Button onClick={onRetryAvailability}>{t("computer.retry")}</Button>} /> : null}
    {surface.mode ? <ComputerPanel expanded title={t(`computer.mode.${surface.mode}`)} modeLabel={activity} elapsed={elapsed}>
    <div className="wf-computer-viewport" data-mode={surface.mode}>
      {surface.mode === "file" ? <FileComputerView scope={scope} runId={surface.runId} file={surface.file} />
        : surface.mode === "browser" ? <BrowserPreviewView scope={scope} controlRequestId={browserControlRequestId} />
        : surface.mode === "terminal" ? <TerminalPreviewView scope={scope} fallbackStep={latestTerminalStep} />
        : surface.mode === "present" ? <PresentComputerView scope={scope} present={surface.present} />
        : surface.mode === "search" ? <SearchComputerView hits={surface.searchHits} />
        : null}
    </div>
    </ComputerPanel> : <div className="wf-computer-waiting">
      <div>
        <LoadingState label={t("computer.waiting")} />
        <div className="wf-computer-waiting-meta"><span>{activity}</span>{elapsed ? <span className="wf-mono">{elapsed}</span> : null}</div>
      </div>
    </div>}
  </div>;
}
