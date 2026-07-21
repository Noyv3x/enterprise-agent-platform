/* <AgentActivity/> — the live agent bubble shown while a run is active AND has
   tool-call steps: a bot avatar + the active work card. */

import type { AgentStatus } from "../../types";
import { Icon } from "../common/Icon";
import { AgentWorkCard } from "./AgentWorkCard";

export function AgentActivity({
  status,
  finalOutputStarted = false,
}: {
  status: AgentStatus;
  finalOutputStarted?: boolean;
}) {
  return (
    <article className="msg msg--agent msg--activity">
      <div className="msg__avatar">
        <Icon name="bot" size={18} />
      </div>
      <AgentWorkCard
        work={status}
        active={true}
        finalOutputStarted={finalOutputStarted}
      />
    </article>
  );
}
