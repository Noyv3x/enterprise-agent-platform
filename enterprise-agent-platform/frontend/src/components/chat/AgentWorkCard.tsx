/* <AgentWorkCard/> — the collapsible agent tool-call card (legacy
   renderAgentWorkCard + step formatters, legacy-app.js:968-1029).

   Per-run open/closed memory lives in the store (expandedAgentRuns) keyed by runId:
   active runs default open, completed runs default closed, and once the user
   toggles, the choice persists (TOGGLE_AGENT_RUN). When the final response starts,
   the live card collapses once so the answer can take focus; that automatic state
   is deliberately local so a later steered turn can expand the work record again.
   The card subscribes to ONLY its own run's flag, so a toggle re-renders just this
   disclosure even though the parent <MessageBubble> is memoized. The native
   <details> toggle is suppressed (controlled `open`) but Enter/Space on the summary
   still fire the click → toggle, preserving keyboard operability.

   The step formatters are exported so <MessageList>/<MessageBubble> can decide
   whether a run has tool-call steps without duplicating the logic. */

import { useLayoutEffect, useState, type MouseEvent } from "react";
import { t as defaultTranslate, useI18n, type MessageKey, type Translator } from "../../i18n";
import { cx } from "../../lib/cx";
import { agentStatusText } from "../../store/selectors";
import { useDispatch, useStore } from "../../store/useStore";
import type { ActivityStep, AgentStatus, AgentWork } from "../../types";
import { Icon } from "../common/Icon";

type Work = AgentWork | AgentStatus;

interface ProcessLineEntry {
  key: string;
  line: string;
  tool: string;
  rawTool: string;
  detail: string;
  state: "running" | "completed" | "failed";
}

const TOOL_MESSAGE_KEYS: Partial<Record<string, MessageKey>> = {
  terminal: "chat.activity.toolName.terminal",
  process: "chat.activity.toolName.process",
  read_file: "chat.activity.toolName.read_file",
  write_file: "chat.activity.toolName.write_file",
  patch_file: "chat.activity.toolName.patch_file",
  search_files: "chat.activity.toolName.search_files",
  session: "chat.activity.toolName.session",
  session_search: "chat.activity.toolName.session",
  memory: "chat.activity.toolName.memory",
  skill: "chat.activity.toolName.skill",
  knowledge: "chat.activity.toolName.knowledge",
  web: "chat.activity.toolName.web",
  browser: "chat.activity.toolName.browser",
  delegate_task: "chat.activity.toolName.delegate_task",
};

function isAgentProcessStep(step: ActivityStep): boolean {
  const stage = String(step?.stage || "").toLowerCase();
  return stage === "tool" || stage.startsWith("tool.");
}

function isAnonymousToolNoise(step: ActivityStep): boolean {
  const stage = String(step?.stage || "").toLowerCase();
  if (stage === "tool.arguments.delta") return true;
  if (stage !== "tool" && !stage.startsWith("tool.")) return false;
  const tool = String(step?.tool || step?.label || "").trim().toLowerCase();
  if (tool && tool !== "tool") return false;
  const detail = String(step?.detail || "").trim().toLowerCase();
  return !detail || detail === "tool";
}

function mergeIdentity(step: ActivityStep): string {
  const stage = String(step?.stage || "").toLowerCase();
  if ((stage === "tool" || stage.startsWith("tool.")) && step?.tool_call_id) {
    return `tool:${step.tool_call_id}`;
  }
  return "";
}

function isTerminalToolStep(step: ActivityStep): boolean {
  const stage = String(step?.stage || "").toLowerCase();
  const status = String(step?.tool_status || "").toLowerCase();
  return (
    stage.endsWith("completed") ||
    stage.endsWith("failed") ||
    status === "completed" ||
    status === "failed"
  );
}

function compactAgentProcessSteps(work: Work | null | undefined): ActivityStep[] {
  const compacted: ActivityStep[] = [];
  const identityIndexes = new Map<string, number>();
  for (const rawStep of work?.activity || []) {
    if (!isAgentProcessStep(rawStep) || isAnonymousToolNoise(rawStep)) continue;
    const step = { ...rawStep };
    const identity = mergeIdentity(step);
    const existingIndex = identity ? identityIndexes.get(identity) : undefined;
    if (existingIndex !== undefined) {
      const previous = compacted[existingIndex]!;
      const merged = {
        ...previous,
        ...step,
        label: step.label || previous.label,
        detail: step.detail || previous.detail,
        line: step.line || previous.line,
      };
      if (identity.startsWith("tool:") && isTerminalToolStep(step)) {
        compacted.splice(existingIndex, 1);
        compacted.push(merged);
        identityIndexes.clear();
        compacted.forEach((item, index) => {
          const itemIdentity = mergeIdentity(item);
          if (itemIdentity) identityIndexes.set(itemIdentity, index);
        });
      } else {
        compacted[existingIndex] = merged;
      }
      continue;
    }
    if (identity) identityIndexes.set(identity, compacted.length);
    compacted.push(step);
  }
  return compacted;
}

function displayToolName(rawTool: string, translate: Translator): string {
  const key = TOOL_MESSAGE_KEYS[rawTool.toLowerCase()];
  return key ? translate(key) : rawTool;
}

function agentStepLine(step: ActivityStep, translate: Translator): string {
  const stage = String(step?.stage || "").toLowerCase();
  const detail = step?.detail || "";
  const rawTool = step?.tool || step?.label || translate("chat.activity.toolFallback");
  const tool = displayToolName(rawTool, translate);
  const detailSuffix = detail && detail !== rawTool ? ` · ${detail}` : "";
  if (step?.tool_status === "failed" || stage.endsWith("failed")) {
    return translate("chat.activity.toolFailed", { tool, detail: detailSuffix });
  }
  return translate(
    step?.tool_status === "completed" || stage.endsWith("completed")
      ? "chat.activity.toolCompleted"
      : "chat.activity.toolRunning",
    { emoji: step?.emoji || "⚙️", tool, detail: detailSuffix },
  );
}

function agentStepState(step: ActivityStep): "running" | "completed" | "failed" {
  const stage = String(step?.stage || "").toLowerCase();
  const status = String(step?.tool_status || "").toLowerCase();
  if (status === "failed" || stage.endsWith("failed")) return "failed";
  if (status === "completed" || stage.endsWith("completed")) return "completed";
  return "running";
}

function agentStepStateText(
  state: "running" | "completed" | "failed",
  translate: Translator,
): string {
  return translate(`chat.activity.state.${state}` as MessageKey);
}

function agentProcessLineEntries(
  work: Work | null | undefined,
  translate: Translator,
): ProcessLineEntry[] {
  const entries: ProcessLineEntry[] = [];
  const keyCounts = new Map<string, number>();
  let previousLine = "";
  let previousIdentity = "";
  for (const [index, step] of compactAgentProcessSteps(work).entries()) {
    const line = agentStepLine(step, translate);
    if (!line) continue;
    const stage = String(step?.stage || "").toLowerCase();
    const identity = mergeIdentity(step);
    if (line === previousLine && identity && identity === previousIdentity) continue;
    previousLine = line;
    previousIdentity = identity;
    const baseKey = identity || `${stage || "step"}:${String(step?.at || index)}:${line}`;
    const occurrence = keyCounts.get(baseKey) || 0;
    keyCounts.set(baseKey, occurrence + 1);
    const rawTool = String(step?.tool || step?.label || translate("chat.activity.toolFallback")).trim();
    entries.push({
      key: occurrence ? `${baseKey}:${occurrence}` : baseKey,
      line,
      tool: displayToolName(rawTool, translate),
      rawTool: rawTool.toLowerCase(),
      detail: String(step?.detail || "").trim(),
      state: agentStepState(step),
    });
  }
  return entries;
}

export function agentProcessLines(
  work: Work | null | undefined,
  translate: Translator = defaultTranslate,
): string[] {
  return agentProcessLineEntries(work, translate).map((entry) => entry.line);
}

export function hasAgentProcessSteps(work: Work | null | undefined): boolean {
  return compactAgentProcessSteps(work).length > 0;
}

function agentWorkTitle(work: Work | null | undefined, translate: Translator): string {
  if (work?.state === "error") return translate("chat.work.failed");
  return translate("chat.work.view");
}

export function AgentWorkCard({
  work,
  active,
  finalOutputStarted = false,
}: {
  work: Work;
  active: boolean;
  finalOutputStarted?: boolean;
}) {
  const dispatch = useDispatch();
  const { t } = useI18n();

  const text = active ? agentStatusText(work, t) || t("chat.status.processing") : agentWorkTitle(work, t);
  const queuedCount = Number(work?.queued_count || 0);
  const waiting = active ? (work?.state === "replying" ? queuedCount : Math.max(0, queuedCount - 1)) : 0;
  const runId = work?.run_id || `${work?.scope_type || "agent"}:${work?.scope_id || ""}:${work?.started_at || ""}`;

  // undefined = no stored preference → default open iff active (legacy hasStored
  // / expanded rule). Subscribing to the single flag keeps re-renders scoped.
  const stored = useStore((state) => state.expandedAgentRuns[runId]);
  const [autoCollapsed, setAutoCollapsed] = useState(finalOutputStarted);

  // Collapse in a layout effect so the first response token and the collapsed
  // disclosure are painted together. Keeping this separate from `stored` means
  // an injected follow-up (output clears, same run continues) expands by default,
  // while a user can still reopen the card after the one-time collapse.
  useLayoutEffect(() => {
    setAutoCollapsed(finalOutputStarted);
  }, [runId, finalOutputStarted]);

  const preferredExpanded = stored === undefined ? active : stored;
  const expanded = !autoCollapsed && preferredExpanded;

  const processEntries = agentProcessLineEntries(work, t);
  const currentEntry = active
    ? [...processEntries].reverse().find((entry) => entry.state === "running")
    : undefined;
  const current = active && currentEntry
    ? t("chat.activity.currentTool", {
        tool: currentEntry.tool,
        status: agentStepStateText(currentEntry.state, t),
      })
    : active
      ? t("chat.status.processing")
      : t("chat.work.completed");

  const onToggle = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    const nextExpanded = !expanded;
    if (nextExpanded && autoCollapsed) setAutoCollapsed(false);
    dispatch({ type: "TOGGLE_AGENT_RUN", payload: { runId, expanded: nextExpanded } });
  };

  return (
    <details className={cx("agent-work", active ? "agent-work--active" : "agent-work--complete")} open={expanded}>
      <summary className="agent-work__summary" onClick={onToggle}>
        {active ? (
          <span className="agent-work__live" aria-hidden="true"><i /></span>
        ) : (
          <span className={cx("agent-work__done", work?.state === "error" && "agent-work__done--failed")}>
            <Icon name={work?.state === "error" ? "alert" : "checkCircle"} size={15} />
          </span>
        )}
        <div className="agent-work__main">
          <span className="agent-work__title">{text}</span>
          <span className="agent-work__step" role="status" aria-live="polite" aria-atomic="true">
            {active ? current : t("chat.work.records", { count: processEntries.length })}
          </span>
        </div>
        {waiting > 0 ? (
          <span className="agent-status__queue">{t("chat.work.waitingCount", { count: waiting })}</span>
        ) : null}
        <span className="agent-work__chevron" aria-hidden="true" />
      </summary>
      {processEntries.length ? (
        <div className="agent-work__log" role="list">
          {processEntries.map((entry) => (
            <div
              className={cx("agent-work__item", `agent-work__item--${entry.state}`)}
              data-tool={entry.rawTool}
              key={entry.key}
              role="listitem"
            >
              <span className="agent-work__item-state" aria-hidden="true">
                {entry.state === "running" ? (
                  <i />
                ) : (
                  <Icon name={entry.state === "failed" ? "alert" : "checkCircle"} size={14} />
                )}
              </span>
              <div className="agent-work__item-main">
                <div className="agent-work__item-head">
                  <span className="agent-work__tool">{entry.tool}</span>
                  <span className="agent-work__item-label">
                    {agentStepStateText(entry.state, t)}
                  </span>
                </div>
                {entry.detail ? (
                  entry.rawTool === "terminal" ? (
                    <div className="agent-work__command">
                      <span className="agent-work__prompt" aria-hidden="true">$</span>
                      <pre aria-label={t("chat.activity.commandPreview")} tabIndex={0}>
                        <code>{entry.detail}</code>
                      </pre>
                    </div>
                  ) : (
                    <div className="agent-work__detail">{entry.detail}</div>
                  )
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </details>
  );
}
