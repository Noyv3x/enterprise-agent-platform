/* <AgentWorkCard/> — the collapsible agent process-step card (legacy
   renderAgentWorkCard + step formatters, legacy-app.js:968-1029).

   Per-run open/closed memory lives in the store (expandedAgentRuns) keyed by runId:
   active runs default open, completed runs default closed, and once the user
   toggles, the choice persists (TOGGLE_AGENT_RUN). The card subscribes to ONLY its
   own run's flag, so a toggle re-renders just this disclosure even though the
   parent <MessageBubble> is memoized. The native <details> toggle is suppressed
   (controlled `open`) but Enter/Space on the summary still fire the click → toggle,
   preserving keyboard operability.

   The step formatters are exported so <MessageList>/<MessageBubble> can decide
   whether a run has process steps without duplicating the logic. */

import type { MouseEvent } from "react";
import { t as defaultTranslate, useI18n, type Translator } from "../../i18n";
import { cx } from "../../lib/cx";
import { agentStatusText } from "../../store/selectors";
import { useDispatch, useStore } from "../../store/useStore";
import type { ActivityStep, AgentStatus, AgentWork } from "../../types";
import { Icon } from "../common/Icon";

type Work = AgentWork | AgentStatus;

function isAgentProcessStep(step: ActivityStep): boolean {
  const stage = String(step?.stage || "").toLowerCase();
  const structuredStage = new Set([
    "complete",
    "completed",
    "queued",
    "replying",
    "approval",
    "approval.responded",
    "error",
    "failed",
  ]).has(stage);
  return (
    step?.source === "hermes" ||
    stage === "tool" ||
    stage.startsWith("tool.") ||
    structuredStage ||
    !!step?.tool
  );
}

function agentStepLine(step: ActivityStep, translate: Translator): string {
  const stage = String(step?.stage || "").toLowerCase();
  const label = step?.label || step?.line || step?.stage || translate("chat.activity.processing");
  const detail = step?.detail || "";
  if (stage === "tool" || stage.startsWith("tool.")) {
    const tool = step?.tool || step?.label || translate("chat.activity.toolFallback");
    const detailSuffix = detail && detail !== tool ? `: "${detail}"` : "";
    return translate(
      step?.tool_status === "completed" || stage.endsWith("completed")
        ? "chat.activity.toolCompleted"
        : "chat.activity.toolRunning",
      { emoji: step?.emoji || "⚙️", tool, detail: detailSuffix },
    );
  }
  if (stage === "complete" || stage === "completed") return translate("chat.activity.completed");
  if (stage === "error" || stage === "failed") {
    return translate("chat.activity.error", { detail: detail ? `: ${detail}` : "" });
  }
  if (stage === "queued") return translate("chat.activity.queued");
  if (stage === "replying") return translate("chat.activity.replying");
  if (stage === "approval") {
    return translate("chat.activity.approval", { detail: detail ? `: ${detail}` : "" });
  }
  if (stage === "approval.responded") return translate("chat.activity.approvalResponded");
  return `• ${label}${detail ? `: ${detail}` : ""}`;
}

export function agentProcessLines(
  work: Work | null | undefined,
  translate: Translator = defaultTranslate,
): string[] {
  const steps = work?.activity || [];
  return steps
    .filter(isAgentProcessStep)
    .map((step) => agentStepLine(step, translate))
    .filter(Boolean);
}

export function hasAgentProcessSteps(work: Work | null | undefined): boolean {
  return (work?.activity || []).some(isAgentProcessStep);
}

function agentWorkTitle(work: Work | null | undefined, translate: Translator): string {
  if (work?.state === "error") return translate("chat.work.failed");
  return translate("chat.work.view");
}

export function AgentWorkCard({ work, active }: { work: Work; active: boolean }) {
  const dispatch = useDispatch();
  const { t } = useI18n();

  const text = active ? agentStatusText(work, t) || t("chat.status.processing") : agentWorkTitle(work, t);
  const queuedCount = Number(work?.queued_count || 0);
  const waiting = active ? (work?.state === "replying" ? queuedCount : Math.max(0, queuedCount - 1)) : 0;
  const runId = work?.run_id || `${work?.scope_type || "agent"}:${work?.scope_id || ""}:${work?.started_at || ""}`;

  // undefined = no stored preference → default open iff active (legacy hasStored
  // / expanded rule). Subscribing to the single flag keeps re-renders scoped.
  const stored = useStore((state) => state.expandedAgentRuns[runId]);
  const expanded = stored === undefined ? active : stored;

  const processLines = agentProcessLines(work, t);
  const current = active ? processLines[processLines.length - 1] || text : t("chat.work.completed");
  const lines = processLines.length
    ? processLines
    : [active ? t("chat.work.waiting") : t("chat.work.noTools")];

  const onToggle = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    dispatch({ type: "TOGGLE_AGENT_RUN", payload: { runId, expanded: !expanded } });
  };

  return (
    <details className={cx("agent-work", active ? "agent-work--active" : "agent-work--complete")} open={expanded}>
      <summary className="agent-work__summary" onClick={onToggle}>
        {active ? (
          <div className="typing__dots">
            <i />
            <i />
            <i />
          </div>
        ) : (
          <div className="agent-work__done">
            <Icon name={work?.state === "error" ? "alert" : "checkCircle"} size={15} />
          </div>
        )}
        <div className="agent-work__main">
          <span className="agent-work__title">{text}</span>
          <span className="agent-work__step">
            {active ? current : t("chat.work.records", { count: processLines.length })}
          </span>
        </div>
        {waiting > 0 ? (
          <span className="agent-status__queue">{t("chat.work.waitingCount", { count: waiting })}</span>
        ) : null}
      </summary>
      <div className="agent-work__log">
        {lines.map((line, index) => (
          <div className="agent-work__line" key={index}>
            {line}
          </div>
        ))}
      </div>
    </details>
  );
}
