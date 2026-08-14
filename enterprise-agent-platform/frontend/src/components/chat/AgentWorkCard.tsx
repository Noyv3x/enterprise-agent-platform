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
  result: string;
  parameters: Record<string, string | number | boolean>;
  startedAt?: number | string;
  completedAt?: number | string;
  state: ProcessState;
  kind: ProcessKind;
}

const PARAMETER_LABELS: Partial<Record<string, MessageKey>> = {
  command: "chat.work.param.command",
  action: "chat.work.param.action",
  path: "chat.work.param.path",
  workspace_path: "chat.work.param.workspace_path",
  query: "chat.work.param.query",
  host: "chat.work.param.host",
  id: "chat.work.param.id",
  target: "chat.work.param.target",
  process_id: "chat.work.param.process_id",
  timeout_ms: "chat.work.param.timeout_ms",
  background: "chat.work.param.background",
  background_kind: "chat.work.param.background_kind",
  cwd: "chat.work.param.cwd",
  offset: "chat.work.param.offset",
  limit: "chat.work.param.limit",
  file_path: "chat.work.param.file_path",
  role: "chat.work.param.role",
  task_count: "chat.work.param.task_count",
  regex: "chat.work.param.regex",
  max_results: "chat.work.param.max_results",
};

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

function closedParameters(step: ActivityStep): Record<string, string | number | boolean> {
  const raw = step?.parameters;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const parameters: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parameters[key] = value;
    }
  }
  return parameters;
}

function formatWorkInstant(value: number | string | undefined, locale: string): string {
  if (value == null || value === "") return "";
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatParameterValue(value: string | number | boolean): string {
  return String(value);
}

function parameterLabel(key: string, translate: Translator): string {
  const messageKey = PARAMETER_LABELS[key];
  return messageKey ? translate(messageKey) : key;
}

function processEntry(step: ActivityStep, index: number, translate: Translator): ProcessLineEntry | null {
  const stage = stepStage(step);
  const rawDetail = String(step?.detail || "").trim();
  const omittedCharacters = Math.max(0, Number(step?.detail_truncated_chars || 0));
  const omittedResultCharacters = Math.max(0, Number(step?.result_truncated_chars || 0));
  const detailNotice = omittedCharacters
    ? translate("chat.activity.truncatedCharacters", { count: omittedCharacters })
    : "";
  const resultNotice = omittedResultCharacters
    ? translate("chat.activity.truncatedCharacters", { count: omittedResultCharacters })
    : "";
  const detail = [rawDetail, detailNotice].filter(Boolean).join("\n\n");
  const rawResult = String(step?.result || "").trim();
  const result = [rawResult, resultNotice].filter(Boolean).join("\n\n");
  const state = agentStepState(step);
  const identity = mergeIdentity(step);
  const key = identity || `${stage || "step"}:${String(step?.at || index)}:${index}`;
  const parameters = closedParameters(step);

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
      result: "",
      parameters: {},
      startedAt: step?.at,
      completedAt: step?.completed_at,
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
      result: "",
      parameters: {},
      startedAt: step?.at,
      completedAt: step?.completed_at,
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
    result,
    parameters,
    startedAt: step?.at,
    completedAt: step?.completed_at,
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
  const { locale, t } = useI18n();
  if (entry.kind === "commentary") {
    return entry.detail
      ? <div className="agent-work__commentary"><MessageBody content={entry.detail} /></div>
      : null;
  }
  if (entry.kind === "notice") {
    return entry.detail ? <div className="agent-work__detail">{entry.detail}</div> : null;
  }

  const command = entry.rawTool === "terminal"
    ? String(entry.parameters.command || entry.detail.split("\n\n")[0] || "").trim()
    : "";
  const summary = command && (entry.detail === command || entry.detail.startsWith(`${command}\n\n`))
    ? entry.detail.slice(command.length).trim()
    : command ? "" : entry.detail;
  const extraParameters = Object.entries(entry.parameters).filter(([key]) => key !== "command");
  const started = formatWorkInstant(entry.startedAt, locale);
  const completed = formatWorkInstant(entry.completedAt, locale);
  const timeLabel = started && completed && started !== completed
    ? `${started} – ${completed}`
    : started || completed;

  return (
    <div className="agent-work__detail agent-work__detail--rich">
      <dl className="agent-work__facts">
        <div>
          <dt>{t("chat.work.detail.tool")}</dt>
          <dd>{entry.title}</dd>
        </div>
        <div>
          <dt>{t("chat.work.detail.status")}</dt>
          <dd>{agentStepStateText(entry.state, t)}</dd>
        </div>
        {timeLabel ? (
          <div>
            <dt>{t("chat.work.detail.time")}</dt>
            <dd>{timeLabel}</dd>
          </div>
        ) : null}
      </dl>
      {command ? (
        <div className="agent-work__section">
          <h4>{t("chat.activity.commandPreview")}</h4>
          <div className="agent-work__command">
            <span className="agent-work__prompt" aria-hidden="true">$</span>
            <pre aria-label={t("chat.activity.commandPreview")} tabIndex={0}><code>{command}</code></pre>
          </div>
        </div>
      ) : null}
      {extraParameters.length ? (
        <div className="agent-work__section">
          <h4>{t("chat.work.detail.parameters")}</h4>
          <dl className="agent-work__params">
            {extraParameters.map(([key, value]) => (
              <div key={key}>
                <dt>{parameterLabel(key, t)}</dt>
                <dd><code>{formatParameterValue(value)}</code></dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
      {summary ? (
        <div className="agent-work__section">
          <h4>{t("chat.work.detail.summary")}</h4>
          <div className="agent-work__detail-text">{summary}</div>
        </div>
      ) : null}
      {entry.result ? (
        <div className="agent-work__section">
          <h4>{t("chat.work.detail.result")}</h4>
          <pre className="agent-work__result" tabIndex={0}><code>{entry.result}</code></pre>
        </div>
      ) : null}
    </div>
  );
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

function entryHasExpandedDetail(entry: ProcessLineEntry): boolean {
  return Boolean(
    entry.detail
    || entry.result
    || Object.keys(entry.parameters).length
    || entry.startedAt
    || entry.kind === "tool",
  );
}

function CompletedProcessList({ entries }: { entries: ProcessLineEntry[] }) {
  const items: CollapseProps["items"] = entries.map((entry) => ({
    key: entry.key,
    label: <EntrySummary entry={entry} expandable={entryHasExpandedDetail(entry)} />,
    children: <EntryDetail entry={entry} />,
    collapsible: entryHasExpandedDetail(entry) ? "header" : "disabled",
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
