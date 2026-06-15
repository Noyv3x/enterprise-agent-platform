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
import { cx } from "../../lib/cx";
import { agentStatusText } from "../../store/selectors";
import { useDispatch, useStore } from "../../store/useStore";
import type { ActivityStep, AgentStatus, AgentWork } from "../../types";
import { Icon } from "../common/Icon";

type Work = AgentWork | AgentStatus;

function isAgentProcessStep(step: ActivityStep): boolean {
  const stage = String(step?.stage || "").toLowerCase();
  return step?.source === "hermes" || stage === "tool" || stage.startsWith("tool.") || !!step?.tool;
}

function agentStepLine(step: ActivityStep): string {
  const stage = String(step?.stage || "").toLowerCase();
  const label = step?.label || step?.stage || "处理中";
  const detail = step?.detail || "";
  if (stage === "tool") return `${step?.emoji || "⚙️"} ${step?.tool || label}${detail ? `: "${detail}"` : "..."}`;
  if (stage === "complete") return `✅ ${label}`;
  if (stage === "error") return `⚠️ ${label}${detail ? `: ${detail}` : ""}`;
  if (stage === "queued") return `⏳ ${label}`;
  if (stage === "replying") return `💬 ${label}`;
  return `• ${label}${detail ? `: ${detail}` : ""}`;
}

export function agentProcessLines(work: Work | null | undefined): string[] {
  const steps = work?.activity || [];
  return steps
    .filter(isAgentProcessStep)
    .map((step) => step.line || agentStepLine(step))
    .filter(Boolean);
}

export function hasAgentProcessSteps(work: Work | null | undefined): boolean {
  return agentProcessLines(work).length > 0;
}

function agentWorkTitle(work: Work | null | undefined): string {
  if (work?.state === "error") return "Agent 工作过程失败";
  return "查看 Agent 工作过程";
}

export function AgentWorkCard({ work, active }: { work: Work; active: boolean }) {
  const dispatch = useDispatch();

  const text = active ? agentStatusText(work) || "Agent 正在处理" : agentWorkTitle(work);
  const queuedCount = Number(work?.queued_count || 0);
  const waiting = active ? (work?.state === "replying" ? queuedCount : Math.max(0, queuedCount - 1)) : 0;
  const current = work?.current_step || (active ? text : "已完成");
  const runId = work?.run_id || `${work?.scope_type || "agent"}:${work?.scope_id || ""}:${work?.started_at || ""}`;

  // undefined = no stored preference → default open iff active (legacy hasStored
  // / expanded rule). Subscribing to the single flag keeps re-renders scoped.
  const stored = useStore((state) => state.expandedAgentRuns[runId]);
  const expanded = stored === undefined ? active : stored;

  const processLines = agentProcessLines(work);
  const lines = processLines.length
    ? processLines
    : [active ? "等待 Hermes Agent 运行过程" : "本次没有工具调用记录"];

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
          <span className="agent-work__step">{active ? current : `${processLines.length} 条工作记录`}</span>
        </div>
        {waiting > 0 ? <span className="agent-status__queue">{`另有 ${waiting} 条等待`}</span> : null}
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
