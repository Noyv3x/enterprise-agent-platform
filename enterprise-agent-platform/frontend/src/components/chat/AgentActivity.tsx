import { useI18n } from "../../i18n";
import { agentStatusText } from "../../store/selectors";
import type { AgentStatus, ChatMode } from "../../types";
import { AgentWorkCard } from "./AgentWorkCard";

export function AgentActivity({ status, mode }: { status: AgentStatus; mode: ChatMode }) {
  const { t } = useI18n();
  return <AgentWorkCard work={status} active statusText={agentStatusText(status, mode, t)} />;
}
