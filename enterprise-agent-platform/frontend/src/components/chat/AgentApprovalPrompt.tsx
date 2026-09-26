import { useRef, useState } from "react";
import { respondAgentApproval } from "../../data/chatActions";
import { useI18n, type MessageKey } from "../../i18n";
import { useStoreHandle } from "../../store/useStore";
import type { AgentApprovalChoice, AgentApprovalRequest, ChatMode } from "../../types";
import { ApprovalPanel } from "../ui/fieldwork";

const ACTIONS: ReadonlyArray<{ choice: AgentApprovalChoice; label: MessageKey }> = [
  { choice: "once", label: "chat.approval.once" },
  { choice: "session", label: "chat.approval.session" },
  { choice: "always", label: "chat.approval.always" },
  { choice: "deny", label: "chat.approval.deny" },
];

export function AgentApprovalPrompt({ approval, mode, scopeId }: {
  approval: AgentApprovalRequest;
  mode: ChatMode;
  scopeId: string;
}) {
  const store = useStoreHandle();
  const { t } = useI18n();
  const pending = useRef(false);
  const [submitting, setSubmitting] = useState<AgentApprovalChoice | null>(null);
  const [outcome, setOutcome] = useState<{ mode: ChatMode; scopeId: string; runId?: string; approvalId?: string; ok: boolean } | null>(null);
  const currentOutcome = outcome?.mode === mode && outcome.scopeId === scopeId
    && outcome.runId === approval.run_id && outcome.approvalId === approval.approval_id ? outcome : null;
  const allowed = new Set(approval.choices || ["once", "session", "always", "deny"]);
  const submit = async (choice: AgentApprovalChoice) => {
    if (pending.current || !allowed.has(choice)) return;
    pending.current = true;
    setSubmitting(choice);
    setOutcome(null);
    try {
      const ok = await respondAgentApproval(store, mode, scopeId, approval, choice);
      setOutcome({ mode, scopeId, runId: approval.run_id, approvalId: approval.approval_id, ok });
    } finally {
      pending.current = false;
      setSubmitting(null);
    }
  };
  return <ApprovalPanel
    title={t("chat.approval.title")}
    description={approval.description || t("chat.approval.fallbackDescription")}
    detail={approval.command ? <pre tabIndex={0}>{approval.command}</pre> : undefined}
    busy={submitting !== null}
    status={submitting ? <span role="status">{t("chat.approval.submitting")}</span> : currentOutcome ? <span role={currentOutcome.ok ? "status" : "alert"}>{t(currentOutcome.ok ? "chat.approvalSubmitted" : "chat.approvalFailed")}</span> : undefined}
    choices={ACTIONS.filter(({ choice }) => allowed.has(choice)).map(({ choice, label }) => ({
      key: choice,
      label: submitting === choice ? t("chat.approval.submitting") : t(label),
      danger: choice === "deny",
      primary: choice === "once",
      onChoose: () => { void submit(choice); },
    }))}
  />;
}
