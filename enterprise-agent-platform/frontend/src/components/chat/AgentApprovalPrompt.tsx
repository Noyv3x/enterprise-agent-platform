import { useState } from "react";
import { respondAgentApproval } from "../../data/chatActions";
import { useStoreHandle } from "../../store/useStore";
import type { AgentApprovalChoice, AgentApprovalRequest, ChatMode } from "../../types";
import { Icon } from "../common/Icon";

const APPROVAL_ACTIONS: Array<{
  choice: AgentApprovalChoice;
  label: string;
  icon: "checkCircle" | "shield" | "key" | "alert";
  primary?: boolean;
}> = [
  { choice: "once", label: "允许一次", icon: "checkCircle", primary: true },
  { choice: "session", label: "本会话允许", icon: "shield" },
  { choice: "always", label: "始终允许", icon: "key" },
  { choice: "deny", label: "拒绝", icon: "alert" },
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
  const [submitting, setSubmitting] = useState<AgentApprovalChoice | null>(null);
  const choices = allowedChoices(approval);
  const description = approval.description || "危险操作需要权限审批";
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
            <strong>权限审批</strong>
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
              <span>{submitting === action.choice ? "提交中" : action.label}</span>
            </button>
          ))}
        </div>
      </section>
    </article>
  );
}
