/* Compact Agent work history.
   Active runs render a non-interactive gateway-style progress list. Completed
   runs start collapsed; opening the run reveals compact rows, and each row
   exposes its full detail only through its own disclosure. */

import { Collapse, type CollapseProps } from "antd";
import { useI18n, type MessageKey, type Translator } from "../../i18n";
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
  title: string;
  rawTool: string;
  preview: string;
  detail: string;
  detailNotice: string;
  result: string;
  resultNotice: string;
  parameters: Record<string, string | number | boolean>;
  startedAt?: number | string;
  completedAt?: number | string;
  state: ProcessState;
  kind: ProcessKind;
}

type ToolFamily = "file" | "terminal" | "search" | "browser" | "generic";

const FILE_TOOLS = new Set(["read_file", "write_file", "patch_file"]);
const TERMINAL_TOOLS = new Set(["terminal", "process"]);
const SEARCH_TOOLS = new Set(["search_files", "web", "knowledge", "session", "session_search"]);
const SESSION_IDENTITY_TOOLS = new Set(["session", "session_search"]);

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

function toolFamily(rawTool: string): ToolFamily {
  if (FILE_TOOLS.has(rawTool)) return "file";
  if (TERMINAL_TOOLS.has(rawTool)) return "terminal";
  if (SEARCH_TOOLS.has(rawTool)) return "search";
  if (rawTool === "browser") return "browser";
  return "generic";
}

function parameterText(entry: ProcessLineEntry, key: string): string {
  const value = entry.parameters[key];
  return value == null ? "" : String(value).trim();
}

function distinctValues(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function entryObjectValues(entry: ProcessLineEntry): string[] {
  const family = toolFamily(entry.rawTool);
  if (family === "file") {
    return distinctValues([
      parameterText(entry, "workspace_path"),
      parameterText(entry, "path"),
    ]);
  }
  if (entry.rawTool === "terminal") {
    return distinctValues([parameterText(entry, "command")]);
  }
  if (entry.rawTool === "process") {
    return distinctValues([
      parameterText(entry, "action"),
      parameterText(entry, "process_id"),
    ]);
  }
  if (family === "search") {
    return distinctValues([
      parameterText(entry, "query"),
      parameterText(entry, "path"),
      parameterText(entry, "host"),
      parameterText(entry, "id"),
    ]);
  }
  if (family === "browser") {
    return distinctValues([
      parameterText(entry, "action"),
      parameterText(entry, "host"),
    ]);
  }
  return distinctValues([
    parameterText(entry, "action"),
    parameterText(entry, "id"),
    parameterText(entry, "file_path"),
    parameterText(entry, "path"),
    parameterText(entry, "query"),
    parameterText(entry, "host"),
    parameterText(entry, "process_id"),
  ]);
}

function identityOnlyAction(entry: ProcessLineEntry): string {
  const action = parameterText(entry, "action");
  if (!action) return "";
  if (SESSION_IDENTITY_TOOLS.has(entry.rawTool)) return action;
  const detail = entry.detail.replace(/\s+/g, " ").trim();
  const normalizedAction = action.replace(/\s+/g, " ").trim();
  const hasOtherContext = Object.entries(entry.parameters).some(([key, value]) => (
    key !== "action"
    && value !== ""
    && !(key === "target" && value === "sandbox")
  ));
  return !hasOtherContext && detail === normalizedAction ? action : "";
}

function terminalCommand(entry: ProcessLineEntry): string {
  if (entry.rawTool !== "terminal") return "";
  return parameterText(entry, "command") || entry.detail.split("\n\n")[0]?.trim() || "";
}

function semanticDetail(entry: ProcessLineEntry): string {
  const detail = entry.detail.trim();
  if (!detail) return "";
  const command = terminalCommand(entry);
  if (command && (detail === command || detail.startsWith(`${command}\n\n`))) {
    return detail.slice(command.length).trim();
  }
  const objects = entryObjectValues(entry);
  if (toolFamily(entry.rawTool) === "file" && !objects.length) {
    // Legacy file rows stored the path only in detail. The row preview already
    // carries that object, so it must not create a duplicate, empty disclosure.
    return "";
  }
  const normalized = detail.replace(/\s+/g, " ").trim();
  const candidates = [
    ...objects,
    identityOnlyAction(entry),
    objects.join(" · "),
    objects.join(": "),
  ].map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean);
  return candidates.includes(normalized) ? "" : detail;
}

function entryPreview(rawTool: string, detail: string, parameters: ProcessLineEntry["parameters"]): string {
  const partial: ProcessLineEntry = {
    key: "",
    title: "",
    rawTool,
    preview: "",
    detail,
    detailNotice: "",
    result: "",
    resultNotice: "",
    parameters,
    state: "running",
    kind: "tool",
  };
  const family = toolFamily(rawTool);
  if (family === "file") return entryObjectValues(partial)[0] || oneLinePreview(detail);
  if (rawTool === "terminal") return oneLinePreview(terminalCommand(partial));
  if (rawTool === "process") return oneLinePreview(entryObjectValues(partial).join(" · ") || detail);
  if (
    SESSION_IDENTITY_TOOLS.has(rawTool)
    && detail.replace(/\s+/g, " ").trim() === identityOnlyAction(partial)
  ) return "";
  if (family === "search" || family === "browser") {
    return oneLinePreview(entryObjectValues(partial).join(" · ") || detail);
  }
  return oneLinePreview(detail || entryObjectValues(partial).join(" · "));
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
    ? translate("chat.activity.truncatedResultCharacters", { count: omittedResultCharacters })
    : "";
  const rawResult = String(step?.result || "").trim();
  const state = agentStepState(step);
  const identity = mergeIdentity(step);
  const key = identity || `${stage || "step"}:${String(step?.at || index)}:${index}`;
  const parameters = closedParameters(step);

  if (isTruncationStep(step)) {
    const omittedEvents = Math.max(1, Number(step?.omitted_events || 1));
    const message = translate("chat.activity.truncatedEvents", { count: omittedEvents });
    return {
      key,
      title: translate("chat.activity.truncatedTitle"),
      rawTool: "work.truncated",
      preview: message,
      detail: message,
      detailNotice: "",
      result: "",
      resultNotice: "",
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
      title: translate("chat.activity.agentUpdate"),
      rawTool: "assistant.message",
      preview: oneLinePreview(String(step?.line || rawDetail)),
      detail: rawDetail,
      detailNotice,
      result: "",
      resultNotice: "",
      parameters: {},
      startedAt: step?.at,
      completedAt: step?.completed_at,
      state,
      kind: "commentary",
    };
  }
  if (!isAgentToolStep(step)) return null;
  const rawTool = String(step?.tool || step?.label || translate("chat.activity.toolFallback")).trim();
  const normalizedTool = rawTool.toLowerCase();
  return {
    key,
    title: displayToolName(rawTool, translate),
    rawTool: normalizedTool,
    preview: entryPreview(normalizedTool, rawDetail, parameters),
    detail: rawDetail,
    detailNotice,
    result: rawResult,
    resultNotice,
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

export function hasAgentProcessSteps(work: Work | null | undefined): boolean {
  return compactToolSteps(work).length > 0 || (work?.activity || []).some(
    (step) => isTruncationStep(step) && Number(step.omitted_tool_events || 0) > 0,
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
  const filePreviewTitle = toolFamily(entry.rawTool) === "file" && entry.preview
    ? entry.preview
    : undefined;
  return (
    <div className="agent-work__item-summary">
      <EntryState entry={entry} />
      <span className="agent-work__tool">{entry.title}</span>
      {entry.preview ? (
        <span className="agent-work__preview" title={filePreviewTitle}>{entry.preview}</span>
      ) : null}
      <span className="agent-work__item-label">{agentStepStateText(entry.state, t)}</span>
      {expandable ? <span className="agent-work__entry-chevron" aria-hidden="true" /> : null}
    </div>
  );
}

function detailParameterEntries(entry: ProcessLineEntry): Array<[string, string | number | boolean]> {
  const family = toolFamily(entry.rawTool);
  return Object.entries(entry.parameters).filter(([key, value]) => {
    if (value === "") return false;
    if (key === "action" && identityOnlyAction(entry)) return false;
    if (family === "file" && (key === "path" || key === "workspace_path")) return false;
    if (entry.rawTool === "terminal" && key === "command") return false;
    if (key === "target" && value === "sandbox") return false;
    return true;
  });
}

function parameterSectionKey(entry: ProcessLineEntry): MessageKey {
  const family = toolFamily(entry.rawTool);
  if (family === "file") return "chat.work.detail.fileContext";
  if (entry.rawTool === "terminal") return "chat.work.detail.executionContext";
  if (entry.rawTool === "process") return "chat.work.detail.processContext";
  if (family === "search") return "chat.work.detail.searchContext";
  if (family === "browser") return "chat.work.detail.browserContext";
  return "chat.work.detail.actionContext";
}

function resultSectionKey(entry: ProcessLineEntry): MessageKey {
  if (entry.state === "failed") return "chat.work.detail.error";
  const family = toolFamily(entry.rawTool);
  if (family === "file") {
    return entry.rawTool === "read_file"
      ? "chat.work.detail.fileContent"
      : "chat.work.detail.changeResult";
  }
  if (entry.rawTool === "process") return "chat.work.detail.processResult";
  if (family === "terminal") return "chat.work.detail.terminalOutput";
  if (family === "search") return "chat.work.detail.searchResults";
  if (family === "browser") return "chat.work.detail.browserResult";
  return "chat.work.detail.result";
}

function DetailParameters({ entry }: { entry: ProcessLineEntry }) {
  const { t } = useI18n();
  const parameters = detailParameterEntries(entry);
  if (!parameters.length) return null;
  return (
    <div className="agent-work__section">
      <h4>{t(parameterSectionKey(entry))}</h4>
      <dl className="agent-work__params">
        {parameters.map(([key, value]) => (
          <div key={key}>
            <dt>{parameterLabel(key, t)}</dt>
            <dd><code>{formatParameterValue(value)}</code></dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function DetailResult({ entry }: { entry: ProcessLineEntry }) {
  const { t } = useI18n();
  if (!entry.result) return null;
  return (
    <div className="agent-work__section">
      <h4>{t(resultSectionKey(entry))}</h4>
      <pre
        className={cx("agent-work__result", entry.state === "failed" && "agent-work__result--error")}
        tabIndex={0}
      ><code>{entry.result}</code></pre>
    </div>
  );
}

function DetailNotice({ children }: { children: string }) {
  if (!children) return null;
  return <div className="agent-work__omission" role="note">{children}</div>;
}

function EntryDetail({ entry }: { entry: ProcessLineEntry }) {
  const { locale, t } = useI18n();
  if (entry.kind === "commentary") {
    return entry.detail || entry.detailNotice ? (
      <div className="agent-work__commentary">
        {entry.detail ? <MessageBody content={entry.detail} /> : null}
        <DetailNotice>{entry.detailNotice}</DetailNotice>
      </div>
    ) : null;
  }
  if (entry.kind === "notice") return null;

  const family = toolFamily(entry.rawTool);
  const command = terminalCommand(entry);
  const summary = semanticDetail(entry);
  const started = formatWorkInstant(entry.startedAt, locale);
  const completed = formatWorkInstant(entry.completedAt, locale);
  const timeLabel = started && completed && started !== completed
    ? `${started} – ${completed}`
    : started || completed;
  const commandSection = command ? (
    <div className="agent-work__section">
      <h4>{t("chat.activity.commandPreview")}</h4>
      <div className="agent-work__command">
        <span className="agent-work__prompt" aria-hidden="true">$</span>
        <pre aria-label={t("chat.activity.commandPreview")} tabIndex={0}><code>{command}</code></pre>
      </div>
    </div>
  ) : null;
  const summarySection = summary ? (
    <div className="agent-work__section">
      <h4>{t(entry.state === "failed" && !entry.result
        ? "chat.work.detail.error"
        : "chat.work.detail.summary")}</h4>
      <div className="agent-work__detail-text">{summary}</div>
    </div>
  ) : null;

  return (
    <div className="agent-work__detail agent-work__detail--rich" data-family={family}>
      {family === "file" ? (
        <>
          <DetailResult entry={entry} />
          <DetailParameters entry={entry} />
          {summarySection}
        </>
      ) : entry.rawTool === "terminal" ? (
        <>
          {commandSection}
          <DetailResult entry={entry} />
          <DetailParameters entry={entry} />
          {summarySection}
        </>
      ) : (
        <>
          <DetailParameters entry={entry} />
          <DetailResult entry={entry} />
          {summarySection}
        </>
      )}
      <DetailNotice>{entry.detailNotice}</DetailNotice>
      <DetailNotice>{entry.resultNotice}</DetailNotice>
      {timeLabel ? (
        <div className="agent-work__detail-meta">
          <span>{t("chat.work.detail.time")}</span>
          <span>{timeLabel}</span>
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
  if (entry.kind === "notice") return false;
  if (entry.kind === "commentary") return Boolean(entry.detail || entry.detailNotice);
  return Boolean(
    entry.result
    || entry.resultNotice
    || entry.detailNotice
    || semanticDetail(entry)
    || terminalCommand(entry)
    || detailParameterEntries(entry).length,
  );
}

function CompletedProcessList({ entries }: { entries: ProcessLineEntry[] }) {
  return (
    <div className="agent-work__log agent-work__entry-list" role="list">
      {entries.map((entry) => {
        const expandable = entryHasExpandedDetail(entry);
        if (!expandable) {
          return (
            <div
              className={cx("agent-work__item", `agent-work__item--${entry.state}`)}
              data-tool={entry.rawTool}
              key={entry.key}
              role="listitem"
            >
              <EntrySummary entry={entry} expandable={false} />
            </div>
          );
        }
        const items: CollapseProps["items"] = [{
          key: entry.key,
          label: <EntrySummary entry={entry} expandable />,
          children: <EntryDetail entry={entry} />,
          showArrow: false,
          className: cx("agent-work__item", `agent-work__item--${entry.state}`),
        }];
        return (
          <div className="agent-work__entry-row" data-tool={entry.rawTool} key={entry.key} role="listitem">
            <Collapse
              className="agent-work__entry-disclosure"
              bordered={false}
              ghost
              classNames={{
                header: "agent-work__entry-header",
                title: "agent-work__entry-title",
                body: "agent-work__entry-body",
              }}
              items={items}
            />
          </div>
        );
      })}
    </div>
  );
}

function completedWorkSummary(entries: ProcessLineEntry[], translate: Translator): string {
  const tools = entries.filter((entry) => entry.kind === "tool");
  const fileCount = tools.filter((entry) => toolFamily(entry.rawTool) === "file").length;
  const terminalCount = tools.filter((entry) => toolFamily(entry.rawTool) === "terminal").length;
  const searchCount = tools.filter((entry) => toolFamily(entry.rawTool) === "search").length;
  const browserCount = tools.filter((entry) => toolFamily(entry.rawTool) === "browser").length;
  const categorizedCount = fileCount + terminalCount + searchCount + browserCount;
  const otherCount = Math.max(0, tools.length - categorizedCount);
  const parts = [
    fileCount ? translate("chat.work.summary.fileActions", { count: fileCount }) : "",
    terminalCount ? translate("chat.work.summary.terminalActions", { count: terminalCount }) : "",
    searchCount ? translate("chat.work.summary.searchActions", { count: searchCount }) : "",
    browserCount ? translate("chat.work.summary.browserActions", { count: browserCount }) : "",
    otherCount ? translate("chat.work.summary.otherActions", { count: otherCount }) : "",
  ].filter(Boolean);
  return parts.length
    ? parts.join(" · ")
    : translate("chat.work.records", { count: entries.length });
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
    : active ? t("chat.status.processing") : completedWorkSummary(entries, t);
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
