import { Button } from "antd";
import { useElapsedSeconds } from "../../hooks/useElapsedSeconds";
import { useI18n, type MessageKey } from "../../i18n";
import type { ComputerMode } from "../../types";
import { formatElapsed } from "../../utils/format";
import { Glyph, LoadingState } from "../ui/fieldwork";
import { useChatPreviewContext } from "./ChatPreviewContext";
import { FileComputerView } from "./FileComputerView";
import { PresentComputerView } from "./PresentComputerView";
import { SearchComputerView } from "./SearchComputerView";
import { CompactTerminalPreview } from "./TerminalPreviewView";
import { useBrowserPreview } from "./useBrowserPreview";
import "./preview.css";

const MODE_LABELS: Record<ComputerMode, MessageKey> = {file:"computer.mode.file",terminal:"computer.mode.terminal",browser:"computer.mode.browser",search:"computer.mode.search",present:"computer.mode.present"};

function Elapsed({live,runId,startedAt}: {live:boolean;runId:string;startedAt:number|null}) {
  const {t}=useI18n();
  const seconds=useElapsedSeconds(startedAt,live && Boolean(runId),runId);
  return seconds == null ? null : <span>{t("computer.pip.elapsed",{time:formatElapsed(seconds)})}</span>;
}

export function ComputerPip() {
  const {t}=useI18n();
  const preview=useChatPreviewContext();
  const surface=preview?.computerSurface;
  const active=Boolean(preview?.scope && surface?.visible && !preview.computerDrawerOpen && !preview.computerPipDismissed);
  const {state}=useBrowserPreview(active && surface?.mode === "browser" ? preview?.scope || null : null);
  if (!active || !preview?.scope || !surface) return null;
  const modeLabel=surface.mode ? t(MODE_LABELS[surface.mode]) : t("computer.waiting");
  const activity=t(surface.live ? "computer.pip.live" : "preview.readOnly");
  const running=!['completed','complete','done','failed','error','cancelled'].includes(String(surface.latestStep?.tool_status || 'running').toLowerCase());
  let content=surface.mode
    ? <LoadingState label={t("computer.loading")} />
    : <span className="wf-computer-pip-waiting">{t("computer.waiting")}</span>;
  if (surface.mode === "file" && (surface.file?.path || surface.file?.workspace_path)) content=<FileComputerView scope={preview.scope} runId={surface.runId} file={surface.file} compact />;
  else if (surface.mode === "browser" && state.frameUrl) content=<img className="wf-computer-thumbnail" src={state.frameUrl} alt={t("browserPreview.frameAlt")} draggable={false} />;
  else if (surface.mode === "search" && (surface.searchHits.length || !surface.live || !running)) content=<SearchComputerView hits={surface.searchHits} compact />;
  else if (surface.mode === "present") content=<PresentComputerView scope={preview.scope} present={surface.present} compact />;
  else if (surface.mode === "terminal") content=<CompactTerminalPreview scope={preview.scope} fallbackStep={surface.latestStep} />;
  return <div className="wf-computer-compact">
    <div className="wf-computer-pip-heading"><strong>{t("computer.title")}</strong><Glyph name="expand" size={14} /></div>
    <div className="wf-computer-peek" aria-hidden="true" inert>{content}</div>
    <div className="wf-computer-pip-meta"><span>{activity}</span><Elapsed live={surface.live} runId={surface.runId} startedAt={surface.startedAt} /></div>
    <Button type="text" className="wf-computer-pip-open" aria-label={t("computer.show")} aria-description={`${modeLabel} · ${activity}`} aria-expanded={false} title={t("computer.show")} onClick={event => preview.openComputer(undefined,event.currentTarget)} />
    <Button type="text" size="small" className="wf-computer-pip-close" aria-label={t("computer.pip.hide")} title={t("computer.pip.hide")} icon={<Glyph name="close" size={14} />} onClick={preview.dismissComputerPip} />
  </div>;
}
