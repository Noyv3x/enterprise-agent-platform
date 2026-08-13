/* Compact Agent work history.
   Active runs render a non-interactive gateway-style progress list. Completed
   runs start collapsed; opening the run reveals compact rows, and each row
   exposes its full detail only through its own disclosure. */

import { Collapse, type CollapseProps } from "antd";
import { t as defaultTranslate, useI18n, type MessageKey, type Translator } from "../../i18n";
import { cx } from "../../lib/cx";
import { agentStatusText } from "../../store/selectors";
import { useDispatch, useStore } from "../../store/useStore";
import type { ActivityStep, AgentStatus, AgentWork, IconName } from "../../types";
import { Icon } from "../common/Icon";
import { MessageBody } from "./MessageBody";

type Work = AgentWork | AgentStatus;
type ProcessState = "running" | "completed" | "failed";
type ProcessKind = "tool" | "commentary" | "notice";

interface ProcessLineEntry {
  key: string;
  line: string;
  title: string;
  rawTool: string;
  preview: string;
  detail: string;
  state: ProcessState;
  kind: ProcessKind;
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

function stepStage(step: ActivityStep): string {
  return String(step?.stage || "").toLowerCase();
}

function isAgentToolStep(step: ActivityStep): boolean {
  const stage = stepStage(step);
  return stage === "tool" || stage.startsWith("tool.");
}

function isCommentaryStep(step: ActivityStep): boolean {
  return stepStage(step) === "assistant.message";
}

function isTruncationStep(step: ActivityStep): boolean {
  return stepStage(step) === "work.truncated";
}

function isVisibleProcessStep(step: ActivityStep): boolean {
  return isAgentToolStep(step) || isCommentaryStep(step) || isTruncationStep(step);
}

function isAnonymousToolNoise(step: ActivityStep): boolean {
  if (!isAgentToolStep(step)) return false;
  const stage = stepStage(step);
  if (stage === "tool.arguments.delta") return true;
  const tool = String(step?.tool || step?.label || "").trim().toLowerCase();
  if (tool && tool !== "tool") return false;
  const detail = String(step?.detail || "").trim().toLowerCase();
  return !detail || detail === "tool";
}

function mergeIdentity(step: ActivityStep): string {
  if (isAgentToolStep(step) && step?.tool_call_id) return `tool:${step.tool_call_id}`;
  return "";
}

function compactVisibleProcessSteps(work: Work | null | undefined): ActivityStep[] {
  const compacted: ActivityStep[] = [];
  const identityIndexes = new Map<string, number>();

  for (const rawStep of work?.activity || []) {
    if (!isVisibleProcessStep(rawStep) || isAnonymousToolNoise(rawStep)) continue;
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
      compacted[existingIndex] = merged;
      continue;
    }
    if (identity) identityIndexes.set(identity, compacted.length);
    compacted.push(step);
  }
  return compacted;
}

function compactToolSteps(work: Work | null | undefined): ActivityStep[] {
  return compactVisibleProcessSteps(work).filter(isAgentToolStep);
}

function displayToolName(rawTool: string, translate: Translator): string {
  const key = TOOL_MESSAGE_KEYS[rawTool.toLowerCase()];
  return key ? translate(key) : rawTool;
}

function agentStepLine(step: ActivityStep, translate: Translator): string {
  const stage = stepStage(step);
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

function agentStepState(step: ActivityStep): ProcessState {
  const stage = stepStage(step);
  const status = String(step?.tool_status || "").toLowerCase();
  if (status === "failed" || stage.endsWith("failed")) return "failed";
  if (
    isCommentaryStep(step) ||
    status === "completed" ||
    stage.endsWith("completed")
  ) return "completed";
  return "running";
}

function agentStepStateText(state: ProcessState, translate: Translator): string {
  return translate(`chat.activity.state.${state}` as MessageKey);
}

function oneLinePreview(value: string, maximum = 96): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maximum) return compact;
  return `${compact.slice(0, maximum - 1).trimEnd()}…`;
}

function processEntry(step: ActivityStep, index: number, translate: Translator): ProcessLineEntry | null {
  const stage = stepStage(step);
  const rawDetail = String(step?.detail || "").trim();
  const omittedCharacters = Math.max(0, Number(step?.detail_truncated_chars || 0));
  const detailNotice = omittedCharacters
    ? translate("chat.activity.truncatedCharacters", { count: omittedCharacters })
    : "";
  const detail = [rawDetail, detailNotice].filter(Boolean).join("\n\n");
  const state = agentStepState(step);
  const identity = mergeIdentity(step);
  const key = identity || `${stage || "step"}:${String(step?.at || index)}:${index}`;

  if (isTruncationStep(step)) {
    const omittedEvents = Math.max(1, Number(step?.omitted_events || 1));
    const message = translate("chat.activity.truncatedEvents", { count: omittedEvents });
    return {
      key,
      line: message,
      title: translate("chat.activity.truncatedTitle"),
      rawTool: "work.truncated",
      preview: message,
      detail: message,
      state: "failed",
      kind: "notice",
    };
  }

  if (isCommentaryStep(step)) {
    return {
      key,
      line: detail,
      title: translate("chat.activity.agentUpdate"),
      rawTool: "assistant.message",
      preview: oneLinePreview(String(step?.line || detail)),
      detail,
      state,
      kind: "commentary",
    };
  }
  if (!isAgentToolStep(step)) return null;
  const rawTool = String(step?.tool || step?.label || translate("chat.activity.toolFallback")).trim();
  return {
    key,
    line: agentStepLine(step, translate),
    title: displayToolName(rawTool, translate),
    rawTool: rawTool.toLowerCase(),
    preview: oneLinePreview(detail),
    detail,
    state,
    kind: "tool",
  };
}

function processEntries(work: Work | null | undefined, translate: Translator): ProcessLineEntry[] {
  const entries: ProcessLineEntry[] = [];
  const keyCounts = new Map<string, number>();
  for (const [index, step] of compactVisibleProcessSteps(work).entries()) {
    const entry = processEntry(step, index, translate);
    if (!entry) continue;
    const occurrence = keyCounts.get(entry.key) || 0;
    keyCounts.set(entry.key, occurrence + 1);
    entries.push(occurrence ? { ...entry, key: `${entry.key}:${occurrence}` } : entry);
  }
  return entries;
}

export function agentProcessLines(
  work: Work | null | undefined,
  translate: Translator = defaultTranslate,
): string[] {
  return compactToolSteps(work).map((step) => agentStepLine(step, translate));
}

export function hasAgentProcessSteps(work: Work | null | undefined): boolean {
  return compactToolSteps(work).length > 0 || (work?.activity || []).some(
    (step) => isTruncationStep(step) && Number(step.omitted_tool_events || 0) > 0,
  );
}

export function hasAgentBrowserStep(work: Work | null | undefined): boolean {
  return compactToolSteps(work).some((step) =>
    String(step?.tool || step?.label || "").trim().toLowerCase() === "browser",
  );
}

function entryIcon(entry: ProcessLineEntry): IconName {
  if (entry.kind === "commentary") return "message";
  if (entry.kind === "notice") return "alert";
  return entry.state === "failed" ? "alert" : "checkCircle";
}

function EntryState({ entry }: { entry: ProcessLineEntry }) {
  return (
    <span className="agent-work__item-state" aria-hidden="true">
      {entry.state === "running" ? <i /> : <Icon name={entryIcon(entry)} size={13} />}
    </span>
  );
}

function EntrySummary({ entry, expandable }: { entry: ProcessLineEntry; expandable: boolean }) {
  const { t } = useI18n();
  return (
    <div className="agent-work__item-summary">
      <EntryState entry={entry} />
      <span className="agent-work__tool">{entry.title}</span>
      {entry.preview ? <span className="agent-work__preview">{entry.preview}</span> : null}
      <span className="agent-work__item-label">{agentStepStateText(entry.state, t)}</span>
      {expandable ? <span className="agent-work__entry-chevron" aria-hidden="true" /> : null}
    </div>
  );
}

function EntryDetail({ entry }: { entry: ProcessLineEntry }) {
  const { t } = useI18n();
  if (!entry.detail) return null;
  if (entry.kind === "commentary") {
    return <div className="agent-work__commentary"><MessageBody content={entry.detail} /></div>;
  }
  if (entry.rawTool === "terminal") {
    return (
      <div className="agent-work__command">
        <span className="agent-work__prompt" aria-hidden="true">$</span>
        <pre aria-label={t("chat.activity.commandPreview")} tabIndex={0}><code>{entry.detail}</code></pre>
      </div>
    );
  }
  return <div className="agent-work__detail">{entry.detail}</div>;
}

function ActiveProcessList({ entries }: { entries: ProcessLineEntry[] }) {
  return (
    <div className="agent-work__log agent-work__log--live" role="list">
      {entries.map((entry) => (
        <div
          className={cx("agent-work__item", `agent-work__item--${entry.state}`)}
          data-tool={entry.rawTool}
          key={entry.key}
          role="listitem"
        >
          <EntrySummary entry={entry} expandable={false} />
        </div>
      ))}
    </div>
  );
}

function CompletedProcessList({ entries }: { entries: ProcessLineEntry[] }) {
  const items: CollapseProps["items"] = entries.map((entry) => ({
    key: entry.key,
    label: <EntrySummary entry={entry} expandable={!!entry.detail} />,
    children: <EntryDetail entry={entry} />,
    collapsible: entry.detail ? "header" : "disabled",
    showArrow: false,
    className: cx("agent-work__item", `agent-work__item--${entry.state}`),
  }));
  return (
    <Collapse
      className="agent-work__log agent-work__entry-list"
      bordered={false}
      ghost
      classNames={{
        header: "agent-work__entry-header",
        title: "agent-work__entry-title",
        body: "agent-work__entry-body",
      }}
      items={items}
    />
  );
}

function WorkSummary({
  work,
  active,
  entries,
  expanded = false,
}: {
  work: Work;
  active: boolean;
  entries: ProcessLineEntry[];
  expanded?: boolean;
}) {
  const { t } = useI18n();
  const warning = work?.state === "error" || work?.state === "needs_review";
  const text = active
    ? agentStatusText(work, t) || t("chat.status.processing")
    : warning ? t("chat.work.failed") : t("chat.work.view");
  const currentEntry = active
    ? [...entries].reverse().find((entry) => entry.state === "running")
    : undefined;
  const status = active && currentEntry
    ? t("chat.activity.currentTool", {
        tool: currentEntry.title,
        status: agentStepStateText(currentEntry.state, t),
      })
    : active ? t("chat.status.processing") : t("chat.work.records", { count: entries.length });
  const queuedCount = Number(work?.queued_count || 0);
  const waiting = active
    ? (work?.state === "replying" ? queuedCount : Math.max(0, queuedCount - 1))
    : 0;

  return (
    <div className="agent-work__summary">
      {active ? (
        <span className="agent-work__live" aria-hidden="true"><i /></span>
      ) : (
        <span className={cx("agent-work__done", warning && "agent-work__done--failed")}>
          <Icon name={warning ? "alert" : "checkCircle"} size={14} />
        </span>
      )}
      <div className="agent-work__main">
        <span className="agent-work__title">{text}</span>
        <span className="agent-work__step" role="status" aria-live="polite" aria-atomic="true">
          {status}
        </span>
      </div>
      {waiting > 0 ? (
        <span className="agent-status__queue">{t("chat.work.waitingCount", { count: waiting })}</span>
      ) : null}
      {!active ? <span className={cx("agent-work__chevron", expanded && "is-open")} aria-hidden="true" /> : null}
    </div>
  );
}

export function AgentWorkCard({ work, active }: { work: Work; active: boolean }) {
  const dispatch = useDispatch();
  const { t } = useI18n();
  const entries = processEntries(work, t);
  const runId = work?.run_id || `${work?.scope_type || "agent"}:${work?.scope_id || ""}:${work?.started_at || ""}`;
  const expanded = useStore((state) => state.expandedAgentRuns[runId] === true);

  if (active) {
    return (
      <div className="agent-work agent-work--active">
        <WorkSummary work={work} active entries={entries} />
        <ActiveProcessList entries={entries} />
      </div>
    );
  }

  const onToggle = (keys: string | string[]) => {
    const nextExpanded = (Array.isArray(keys) ? keys : [keys]).includes("process");
    dispatch({ type: "TOGGLE_AGENT_RUN", payload: { runId, expanded: nextExpanded } });
  };
  return (
    <Collapse
      className={cx("agent-work", "agent-work--complete", expanded && "agent-work--expanded")}
      activeKey={expanded ? ["process"] : []}
      bordered={false}
      ghost
      classNames={{
        header: "agent-work__collapse-header",
        title: "agent-work__collapse-title",
        body: "agent-work__collapse-body",
      }}
      onChange={onToggle}
      items={[{
        key: "process",
        label: <WorkSummary work={work} active={false} entries={entries} expanded={expanded} />,
        children: <CompletedProcessList entries={entries} />,
        showArrow: false,
      }]}
    />
  );
}
