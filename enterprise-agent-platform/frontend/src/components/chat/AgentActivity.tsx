/* <AgentActivity/> — the live agent bubble shown while a run is active AND has
   tool/process steps (legacy renderAgentActivity, :934-939): a bot avatar + the
   active work card. */

import type { AgentStatus } from "../../types";
import { Icon } from "../common/Icon";
import { AgentWorkCard } from "./AgentWorkCard";

export function AgentActivity({ status }: { status: AgentStatus }) {
  return (
    <article className="msg msg--agent msg--activity">
      <div className="msg__avatar">
        <Icon name="bot" size={18} />
      </div>
      <AgentWorkCard work={status} active={true} />
    </article>
  );
}
