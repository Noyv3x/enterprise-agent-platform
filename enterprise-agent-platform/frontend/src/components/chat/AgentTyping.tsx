/* <AgentTyping/> — the lightweight "Agent 正在处理" line shown while a run is
   active but has no tool-call steps yet. */

import { useI18n } from "../../i18n";
import { agentStatusText } from "../../store/selectors";
import type { AgentStatus } from "../../types";

export function AgentTyping({ status }: { status: AgentStatus }) {
  const { t } = useI18n();
  return (
    <div className="typing-line typing-line--agent">
      <span>{agentStatusText(status, t) || t("chat.status.processing")}</span>
      <div className="typing__dots">
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}
