import { useElapsedSeconds } from "../../hooks/useElapsedSeconds";
import { useI18n } from "../../i18n";
import { agentStatusText } from "../../store/selectors";
import type { AgentStatus } from "../../types";
import { formatElapsed } from "../../utils/format";
import { StatusMark } from "../ui/fieldwork";

/** Loading state before the first tool call: live ring, the real status wording, and elapsed time since the run started. */
export function AgentTyping({ status }: { status: AgentStatus }) {
  const { t } = useI18n();
  const waitingForApproval = status.state === "approval";
  const seconds = useElapsedSeconds(status.started_at, !waitingForApproval, status.run_id || "");
  return <div className="wf-agent-typing">
    <div role="status" aria-live="polite"><StatusMark subtle busy={!waitingForApproval} tone={waitingForApproval ? "warning" : "info"}>{agentStatusText(status, t) || t("chat.status.processing")}</StatusMark></div>
    {seconds != null && <span className="wf-work-elapsed wf-mono" aria-label={t("chat.work.elapsed", { time: formatElapsed(seconds) })}>{formatElapsed(seconds)}</span>}
  </div>;
}
