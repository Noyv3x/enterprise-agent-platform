import { useElapsedSeconds } from "../../hooks/useElapsedSeconds";
import { useI18n } from "../../i18n";
import { agentStatusText } from "../../store/selectors";
import type { AgentStatus } from "../../types";
import { formatElapsed } from "../../utils/format";
import { LoadingState } from "../ui/beautiful";
import { Glyph } from "../ui/fieldwork";

/** Before the first tool call: Beautiful UI's loading state — real status wording and time since the run started. */
export function AgentTyping({ status }: { status: AgentStatus }) {
  const { t } = useI18n();
  const waitingForApproval = status.state === "approval";
  const seconds = useElapsedSeconds(status.started_at, !waitingForApproval, status.run_id || "");
  const time = seconds == null ? "" : formatElapsed(seconds);
  const label = agentStatusText(status, t) || t("chat.status.processing");
  const elapsed = time ? <><span className="wf-sr-only">{t("chat.work.elapsed", { time })}</span><span aria-hidden="true">{time}</span></> : undefined;
  if (waitingForApproval) {
    return <div className="mb-3 flex w-fit items-center gap-2 text-[13px] font-medium text-ink-2">
      <span className="flex text-orange" aria-hidden="true"><Glyph name="lock" size={14} /></span>
      <span role="status" aria-live="polite">{label}</span>
    </div>;
  }
  return <div className="mb-3 min-h-7 py-1">
    <LoadingState label={<span role="status" aria-live="polite">{label}</span>} elapsed={elapsed} />
  </div>;
}
