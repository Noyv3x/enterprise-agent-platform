import { useElapsedSeconds } from "../../hooks/useElapsedSeconds";
import { useI18n } from "../../i18n";
import { agentStatusText } from "../../store/selectors";
import type { AgentStatus } from "../../types";
import { formatElapsed } from "../../utils/format";
import { Glyph } from "../ui/fieldwork";
import "./work.css";

/** Before the first tool call: the work-trace header alone — real status wording and time since the run started. */
export function AgentTyping({ status }: { status: AgentStatus }) {
  const { t } = useI18n();
  const waitingForApproval = status.state === "approval";
  const seconds = useElapsedSeconds(status.started_at, !waitingForApproval, status.run_id || "");
  const time = seconds == null ? "" : formatElapsed(seconds);
  return <div className={`wf-trace wf-trace--${waitingForApproval ? "approval" : "live"}`}>
    <div className="wf-trace-head wf-trace-head--static">
      <span className="wf-trace-sign" aria-hidden="true"><Glyph name={waitingForApproval ? "lock" : "sparkle"} size={14} /></span>
      <span className="wf-trace-label" role="status" aria-live="polite">{agentStatusText(status, t) || t("chat.status.processing")}</span>
      {time && <span className="wf-trace-meta"><span className="wf-trace-time"><span className="wf-sr-only">{t("chat.work.elapsed", { time })}</span><span aria-hidden="true">{time}</span></span></span>}
    </div>
  </div>;
}
