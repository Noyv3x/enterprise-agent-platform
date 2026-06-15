/* <AgentTyping/> — the lightweight "Agent 正在处理" line shown while a run is
   active but has no process steps yet (legacy renderAgentTyping, :941-946). */

import { agentStatusText } from "../../store/selectors";
import type { AgentStatus } from "../../types";

export function AgentTyping({ status }: { status: AgentStatus }) {
  return (
    <div className="typing-line typing-line--agent">
      <span>{agentStatusText(status) || "Agent 正在处理"}</span>
      <div className="typing__dots">
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}
