import { Button } from "antd";
import { useEffect, useState } from "react";
import { useI18n, type MessageKey } from "../../i18n";
import type { ComputerMode } from "../../types";
import { ComputerPanel, LoadingState, StatusMark } from "../ui/fieldwork";
import { useChatPreviewContext } from "./ChatPreviewContext";
import { FileComputerView } from "./FileComputerView";
import { PresentComputerView } from "./PresentComputerView";
import { SearchComputerView } from "./SearchComputerView";
import { CompactTerminalPreview } from "./TerminalPreviewView";
import { useBrowserPreview } from "./useBrowserPreview";
import "./preview.css";

const MODE_LABELS: Record<ComputerMode, MessageKey> = {file:"computer.mode.file",terminal:"computer.mode.terminal",browser:"computer.mode.browser",search:"computer.mode.search",present:"computer.mode.present"};

export function formatComputerElapsed(totalSeconds:number):string {
  const bounded=Math.max(0,Math.floor(totalSeconds));
  const seconds=bounded%60;
  const minutes=Math.floor(bounded/60)%60;
  const hours=Math.floor(bounded/3600);
  return [...(hours ? [String(hours).padStart(2,"0")] : []),String(minutes).padStart(2,"0"),String(seconds).padStart(2,"0")].join(":");
}

function Elapsed({live,runId,startedAt}: {live:boolean;runId:string;startedAt:number|null}) {
  const {t}=useI18n();
  const [now,setNow]=useState(Date.now);
  const timing=live && Boolean(runId) && startedAt != null && Number.isFinite(startedAt) && startedAt > 0;
  useEffect(() => { if (!timing) return; setNow(Date.now());const timer=window.setInterval(() => setNow(Date.now()),1000);return () => window.clearInterval(timer); },[timing,runId,startedAt]);
  return timing ? <span>{t("computer.pip.elapsed",{time:formatComputerElapsed((now-Number(startedAt)*1000)/1000)})}</span> : null;
}

export function ComputerPip() {
  const {t}=useI18n();
  const preview=useChatPreviewContext();
  const surface=preview?.computerSurface;
  const active=Boolean(preview?.scope && surface?.visible && !preview.computerDrawerOpen);
  const {state}=useBrowserPreview(active && surface?.mode === "browser" ? preview?.scope || null : null);
  if (!active || !preview?.scope || !surface) return null;
  const modeLabel=surface.mode ? t(MODE_LABELS[surface.mode]) : t("computer.title");
  const activity=t(surface.live ? "computer.pip.live" : "preview.readOnly");
  const running=!['completed','complete','done','failed','error','cancelled'].includes(String(surface.latestStep?.tool_status || 'running').toLowerCase());
  let content=<LoadingState label={t("computer.loading")} />;
  if (surface.mode === "file" && (surface.file?.path || surface.file?.workspace_path)) content=<FileComputerView scope={preview.scope} runId={surface.runId} file={surface.file} compact />;
  else if (surface.mode === "browser" && state.frameUrl) content=<img className="wf-computer-thumbnail" src={state.frameUrl} alt={t("browserPreview.frameAlt")} draggable={false} />;
  else if (surface.mode === "search" && (surface.searchHits.length || !surface.live || !running)) content=<SearchComputerView hits={surface.searchHits} compact />;
  else if (surface.mode === "present") content=<PresentComputerView scope={preview.scope} present={surface.present} compact />;
  else if (surface.mode === "terminal") content=<CompactTerminalPreview scope={preview.scope} fallbackStep={surface.latestStep} />;
  return <div className="wf-computer-compact">
    <ComputerPanel title={t("computer.title")} modeLabel={modeLabel} status={<StatusMark tone={surface.live ? "info" : "neutral"}>{activity}</StatusMark>} elapsed={<Elapsed live={surface.live} runId={surface.runId} startedAt={surface.startedAt} />}
      actions={<Button aria-label={t("computer.show")} aria-description={`${modeLabel} · ${activity}`} onClick={event => preview.openComputer(undefined,event.currentTarget)}>{t("computer.show")}</Button>}>
      <div className="wf-computer-peek" aria-hidden="true" inert>{content}</div>
    </ComputerPanel>
  </div>;
}
