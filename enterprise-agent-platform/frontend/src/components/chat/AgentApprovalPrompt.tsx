import { useState } from "react";
import { respondAgentApproval } from "../../data/chatActions";
import { useI18n, type MessageKey } from "../../i18n";
import { useStoreHandle } from "../../store/useStore";
import type { AgentApprovalChoice, AgentApprovalRequest, ChatMode } from "../../types";
import { Icon } from "../common/Icon";

const APPROVAL_ACTIONS: Array<{
  choice: AgentApprovalChoice;
  labelKey: MessageKey;
  icon: "checkCircle" | "shield" | "key" | "alert";
  primary?: boolean;
}> = [
  { choice: "once", labelKey: "chat.approval.once", icon: "checkCircle", primary: true },
  { choice: "session", labelKey: "chat.approval.session", icon: "shield" },
  { choice: "always", labelKey: "chat.approval.always", icon: "key" },
  { choice: "deny", labelKey: "chat.approval.deny", icon: "alert" },
];

function allowedChoices(approval: AgentApprovalRequest): Set<string> {
  const raw = approval.choices || ["once", "session", "always", "deny"];
  return new Set(raw.map((item) => String(item)));
}

export function AgentApprovalPrompt({
  approval,
  mode,
  scopeId,
}: {
  approval: AgentApprovalRequest;
  mode: ChatMode;
  scopeId: string;
}) {
  const store = useStoreHandle();
  const { t } = useI18n();
  const [submitting, setSubmitting] = useState<AgentApprovalChoice | null>(null);
  const choices = allowedChoices(approval);
  const description = approval.description || t("chat.approval.fallbackDescription");
  const command = approval.command || "";

  const submit = async (choice: AgentApprovalChoice) => {
    if (submitting) return;
    setSubmitting(choice);
    try {
      await respondAgentApproval(store, mode, scopeId, choice);
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <article className="msg msg--agent msg--activity">
      <div className="msg__avatar">
        <Icon name="shield" size={18} />
      </div>
      <section className="agent-approval">
        <div className="agent-approval__head">
          <Icon name="shield" size={16} />
          <div>
            <strong>{t("chat.approval.title")}</strong>
            <span>{description}</span>
          </div>
        </div>
        {command ? <pre className="agent-approval__command">{command}</pre> : null}
        <div className="agent-approval__actions">
          {APPROVAL_ACTIONS.filter((action) => choices.has(action.choice)).map((action) => (
            <button
              className={action.primary ? "btn btn--primary btn--sm" : "btn btn--sm"}
              disabled={!!submitting}
              key={action.choice}
              onClick={() => void submit(action.choice)}
              type="button"
            >
              <Icon name={action.icon} size={14} />
              <span>{submitting === action.choice ? t("chat.approval.submitting") : t(action.labelKey)}</span>
            </button>
          ))}
        </div>
      </section>
    </article>
  );
}
