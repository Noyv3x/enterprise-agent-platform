import { useI18n } from "../../i18n";
import { agentStatusText } from "../../store/selectors";
import type { AgentStatus } from "../../types";
import { StatusMark } from "../ui/beautiful"

export function AgentTyping({ status }: { status: AgentStatus }) {
  const { t } = useI18n();
  return <div role="status" aria-live="polite"><StatusMark tone={status.state === "approval" ? "warning" : "info"}>{agentStatusText(status, t) || t("chat.status.processing")}</StatusMark></div>;
}
