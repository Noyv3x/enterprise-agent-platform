import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject, type TransitionEvent } from "react";
import { useElapsedSeconds } from "../../hooks/useElapsedSeconds";
import { useI18n, type MessageKey, type Translator } from "../../i18n";
import { agentStatusText } from "../../store/selectors";
import { useDispatch, useStore, useStoreHandle } from "../../store/useStore";
import type { ActivityStep, AgentStatus, AgentWork, AppState } from "../../types";
import { formatElapsed } from "../../utils/format";
import { Shimmer } from "../ui/beautiful";
import { Glyph, type GlyphName } from "../ui/fieldwork";
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

const FILE_TOOLS: Partial<Record<string, true>> = { read_file: true, write_file: true, patch_file: true };
const TERMINAL_TOOLS: Partial<Record<string, true>> = { terminal: true, process: true };
const SEARCH_TOOLS: Partial<Record<string, true>> = { search_files: true, web: true, session: true, session_search: true };
const SESSION_IDENTITY_TOOLS: Partial<Record<string, true>> = { session: true, session_search: true };

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
  server: "chat.work.param.server",
  tool: "chat.work.param.tool",
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
  mcp: "chat.activity.toolName.mcp",
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
  if (tool.startsWith("learning.review.")) return true;
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
  if (Object.prototype.hasOwnProperty.call(FILE_TOOLS, rawTool)) return "file";
  if (Object.prototype.hasOwnProperty.call(TERMINAL_TOOLS, rawTool)) return "terminal";
  if (Object.prototype.hasOwnProperty.call(SEARCH_TOOLS, rawTool)) return "search";
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
  if (Object.prototype.hasOwnProperty.call(SESSION_IDENTITY_TOOLS, entry.rawTool)) return action;
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
    Object.prototype.hasOwnProperty.call(SESSION_IDENTITY_TOOLS, rawTool)
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
    : translate("chat.work.steps", { count: entries.filter((entry) => entry.kind !== "notice").length });
}

/* Evidence follows Beautiful UI ToolChips' expanded detail: a hairline-led column under the row, code on
   field chips. It shows the real command, output and parameters. */
const EVIDENCE_HEADING = "m-0 text-[11.5px] leading-[1.5] font-medium text-ink-3";
const EVIDENCE_CODE = "m-0 max-h-80 max-w-full overflow-auto rounded-control bg-field px-2.5 py-2 font-mono text-[11.5px] leading-[1.6] text-ink shadow-hairline whitespace-pre-wrap [overflow-wrap:anywhere] [tab-size:2]";
const EVIDENCE_DANGER_CODE = "bg-red-tint text-ink shadow-[0_0_0_1px_color-mix(in_srgb,var(--red)_24%,transparent)]";

function EvidenceSection({ label, danger = false, children }: { label: string; danger?: boolean; children: ReactNode }) {
  return <section aria-label={label} className="grid min-w-0 gap-1">
    <h4 className={`${EVIDENCE_HEADING}${danger ? " text-red" : ""}`}>{label}</h4>
    {children}
  </section>;
}

function Evidence({ entry }: { entry: ProcessLineEntry }) {
  const { t, locale } = useI18n();
  const column = "mt-0.5 mb-2 ml-[11px] flex min-w-0 flex-col gap-2.5 border-l border-line py-1 pl-3.5";
  if (entry.kind === "commentary") return <div className={`${column} text-[13px] leading-[1.6] text-ink-2`} role="group" aria-label={entry.title}>
    {entry.detail && <MessageBody content={entry.detail} />}
    {entry.detailNotice && <p className="m-0 text-[11.5px] text-orange" role="note">{entry.detailNotice}</p>}
  </div>;
  const command = terminalCommand(entry);
  const summary = semanticDetail(entry);
  const parameters = detailParameterEntries(entry);
  const failed = entry.state === "failed";
  const started = formatWorkInstant(entry.startedAt, locale);
  const completed = formatWorkInstant(entry.completedAt, locale);
  const time = started && completed && started !== completed ? `${started} – ${completed}` : started || completed;
  const resultLabel = t(resultSectionKey(entry));
  const result = entry.result ? <EvidenceSection label={resultLabel} danger={failed}>
    <pre tabIndex={0} className={`${EVIDENCE_CODE}${failed ? ` ${EVIDENCE_DANGER_CODE}` : ""}`}><code>{entry.result}</code></pre>
  </EvidenceSection> : null;
  const contextLabel = t(parameterSectionKey(entry));
  const context = parameters.length ? <EvidenceSection label={contextLabel}>
    <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11.5px] leading-[1.6]">
      {parameters.map(([key, value]) => <div key={key} className="contents">
        <dt className="text-ink-3">{parameterLabel(key, t)}</dt>
        <dd className="m-0 min-w-0 font-mono text-ink [overflow-wrap:anywhere]">{formatParameterValue(value)}</dd>
      </div>)}
    </dl>
  </EvidenceSection> : null;
  const summaryIsError = failed && !entry.result;
  return <div className={column} role="group" aria-label={entry.title}>
    {command && <section className="grid min-w-0 gap-1">
      <h4 className={EVIDENCE_HEADING}>{t("chat.activity.commandPreview")}</h4>
      <pre className={EVIDENCE_CODE} aria-label={t("chat.activity.commandPreview")} tabIndex={0}><code className="before:text-ink-3 before:content-['$_'] before:select-none">{command}</code></pre>
    </section>}
    {toolFamily(entry.rawTool) === "file" || entry.rawTool === "terminal" ? <>{result}{context}</> : <>{context}{result}</>}
    {summary && <section className="grid min-w-0 gap-1">
      <h4 className={`${EVIDENCE_HEADING}${summaryIsError ? " text-red" : ""}`}>{t(summaryIsError ? "chat.work.detail.error" : "chat.work.detail.summary")}</h4>
      <pre tabIndex={0} className={`${EVIDENCE_CODE} font-sans${summaryIsError ? ` ${EVIDENCE_DANGER_CODE}` : ""}`}>{summary}</pre>
    </section>}
    {entry.detailNotice && <p className="m-0 text-[11.5px] text-orange" role="note">{entry.detailNotice}</p>}
    {entry.resultNotice && <p className="m-0 text-[11.5px] text-orange" role="note">{entry.resultNotice}</p>}
    {time && <p className="m-0 text-[11.5px] text-ink-3">{t("chat.work.detail.time")} <time className="font-mono tabular-nums">{time}</time></p>}
  </div>;
}

/** Longest computed transition (duration + delay) in ms; 0 under reduced motion, where the global rule removes transitions. */
function transitionMilliseconds(element: HTMLElement): number {
  const style = window.getComputedStyle(element);
  const toMilliseconds = (list: string) => list.split(",").map((part) => {
    const value = part.trim();
    const amount = Number.parseFloat(value);
    if (!Number.isFinite(amount)) return 0;
    return value.endsWith("ms") ? amount : amount * 1000;
  });
  const durations = toMilliseconds(style.transitionDuration || "");
  const delays = toMilliseconds(style.transitionDelay || "");
  return durations.reduce((longest, duration, index) => Math.max(longest, duration + (delays[index % delays.length] || 0)), 0);
}

/**
 * Disclosure plumbing shared by the trace and its rows. The panel element stays mounted so the CSS
 * grid-row/opacity transition can run both ways; its content mounts on open and unmounts only after
 * the closing transition. Closing a panel that holds focus returns focus to its trigger first,
 * including the one automatic collapse when a live run settles.
 */
interface Disclosure {
  /** true while open and through the closing transition */
  mounted: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  onTransitionEnd: (event: TransitionEvent<HTMLDivElement>) => void;
}

function useDisclosure(open: boolean): Disclosure {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const [previous, setPrevious] = useState(open);
  if (previous !== open) {
    setPrevious(open);
    setClosing(!open);
  }
  useLayoutEffect(() => {
    if (open) return;
    const panel = panelRef.current;
    if (panel && panel.contains(document.activeElement)) triggerRef.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!closing) return;
    const duration = panelRef.current ? transitionMilliseconds(panelRef.current) : 0;
    const timer = window.setTimeout(() => setClosing(false), duration ? duration + 50 : 0);
    return () => window.clearTimeout(timer);
  }, [closing]);
  const onTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && !open) setClosing(false);
  };
  return { mounted: open || closing, triggerRef, panelRef, onTransitionEnd };
}

const FAMILY_GLYPHS: Record<ToolFamily, GlyphName> = { file: "file", terminal: "terminal", search: "search", browser: "browser", generic: "sparkle" };

/* Beautiful UI glyphs: the Thinking sparkle and the disclosure chevron. */
function SparkleMark({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" /></svg>;
}
function ChevronDown({ size = 14, className, style }: { size?: number; className?: string; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className} style={style}><path d="M6 9l6 6 6-6" /></svg>;
}
/** Beautiful UI's step spinner: a hairline ring with an ink arc. */
function StepSpinner() {
  return <span className="size-3 shrink-0 rounded-full border-[1.5px] border-line-strong border-t-ink-2" style={{ animation: "spin 700ms linear infinite" }} />;
}

/** The collapsible body shared by the trace and its rows: grid rows 0fr↔1fr with an opacity fade. */
function DisclosurePanel({ id, open, disclosure, children }: { id: string; open: boolean; disclosure: Disclosure; children: ReactNode }) {
  return <div ref={disclosure.panelRef} id={id} className="wf-trace-panel grid min-w-0 transition-[grid-template-rows,opacity] duration-300 ease-out-strong"
    style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }} data-open={open} inert={!open || undefined} onTransitionEnd={disclosure.onTransitionEnd}>
    <div className="min-h-0 min-w-0 overflow-hidden">{disclosure.mounted && children}</div>
  </div>;
}

/** One sign per row: running rows spin, failures warn, settled rows show what kind of work they were. */
function StepSign({ entry }: { entry: ProcessLineEntry }) {
  if (entry.kind === "notice") return <span className="flex text-orange"><Glyph name="warning" size={13} /></span>;
  if (entry.state === "failed") return <span className="flex text-red"><Glyph name="warning" size={13} /></span>;
  if (entry.state === "running") return <StepSpinner />;
  if (entry.kind === "commentary") return <SparkleMark size={12} />;
  return <Glyph name={FAMILY_GLYPHS[toolFamily(entry.rawTool)]} size={13} />;
}

/** Paths, commands and queries read as code; prose-like previews (browser, commentary, generic tools) stay in the body face. */
function usesMonoPreview(entry: ProcessLineEntry): boolean {
  const family = toolFamily(entry.rawTool);
  return entry.kind === "tool" && (family === "file" || family === "terminal" || family === "search");
}

/** A Beautiful UI tool chip row: sign (swapping to a chevron on hover/open), label, value chip, and the evidence below. */
function TraceStep({ entry }: { entry: ProcessLineEntry }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const expandable = entry.state !== "running" && entryHasExpandedDetail(entry);
  const open = expandable && expanded;
  const disclosure = useDisclosure(open);
  const notice = entry.kind === "notice";
  const failed = !notice && entry.state === "failed";
  const row = <>
    <span className="relative flex size-4 shrink-0 items-center justify-center text-ink-3" aria-hidden="true">
      <span className={`flex transition-opacity duration-100${expandable ? ` group-hover/row:opacity-0${open ? " opacity-0" : ""}` : ""}`}><StepSign entry={entry} /></span>
      {expandable && <ChevronDown size={12} className={`absolute transition-[opacity,transform] duration-150 group-hover/row:opacity-100 ${open ? "opacity-100" : "opacity-0"}`} style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }} />}
    </span>
    <span className={`max-w-[60%] shrink-0 truncate text-[12.5px] ${notice ? "font-normal text-ink-2" : "font-medium text-ink"}`}>{entry.title}</span>
    {entry.preview && (notice
      ? <span className="min-w-0 basis-full pl-6 text-[11.5px] leading-[1.6] text-ink-2 [overflow-wrap:anywhere]">{entry.preview}</span>
      : <span className={`inline-block h-5.5 min-w-0 truncate rounded-chip bg-field px-1.5 text-[11.5px] leading-[22px] text-ink-2 shadow-hairline${usesMonoPreview(entry) ? " font-mono" : ""}`} title={toolFamily(entry.rawTool) === "file" ? entry.preview : undefined}>{entry.preview}</span>)}
    {!notice && <span className={failed ? "shrink-0 text-[11.5px] font-medium text-red" : "wf-sr-only"}>{agentStepStateText(entry.state, t)}</span>}
  </>;
  const rowClass = `flex w-full min-w-0 items-center gap-2 rounded-control px-1.5 text-left${notice ? " flex-wrap py-1" : " min-h-7"}`;
  return <li className="min-w-0" style={{ animation: "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both" }}>
    {expandable
      ? <button ref={disclosure.triggerRef} type="button" className={`group/row ${rowClass} transition-colors duration-100 hover:bg-hover-2${open ? " bg-hover" : ""}`} aria-expanded={open} aria-controls={panelId} onClick={() => setExpanded(!open)}>{row}</button>
      : <div className={rowClass}>{row}</div>}
    {expandable && <DisclosurePanel id={panelId} open={open} disclosure={disclosure}><Evidence entry={entry} /></DisclosurePanel>}
  </li>;
}

/**
 * A live record is replaced by a new instance when its run settles (MessageList swaps the live
 * activity for the persisted message, or for the error record). Focus inside the live record would
 * fall to <body>, so it is handed to the same run's next header in the same conversation log. A
 * pending handoff waits briefly for a record that mounts later, and otherwise falls back to that log.
 * Handoffs are fenced per log element and cancelled when the conversation itself changed (account,
 * view or channel), so navigation never synthesizes focus; focus the user placed elsewhere is never taken.
 */
interface RunFocusRegistry {
  headers: Map<string, Set<RefObject<HTMLButtonElement | null>>>;
  pending: Map<string, { conversation: string; movedToLog: boolean }>;
}
const runFocusRegistries = new WeakMap<HTMLElement, RunFocusRegistry>();
/** Long enough for the persisted message to arrive in a following store update; short enough not to surprise a reader later. */
const HANDOFF_WINDOW_MS = 2000;

function runFocusRegistry(log: HTMLElement): RunFocusRegistry {
  let registry = runFocusRegistries.get(log);
  if (!registry) {
    registry = { headers: new Map(), pending: new Map() };
    runFocusRegistries.set(log, registry);
  }
  return registry;
}

/** The conversation a log is showing; a change between render and unmount means navigation, not a settling run. */
function conversationIdentity(state: AppState): string {
  return `${state.user?.id ?? ""}:${state.activeView}:${state.activeChannelId ?? ""}`;
}

/** True when focus was lost with the removed record (body, nothing, or a detached node). */
function focusWasDropped(): boolean {
  const current = document.activeElement;
  return !current || current === document.body || !current.isConnected;
}

function useRunFocusHandoff(runId: string, replaceable: boolean, triggerRef: RefObject<HTMLButtonElement | null>, sectionRef: RefObject<HTMLElement | null>) {
  const store = useStoreHandle();
  const latest = useRef({ runId, replaceable, conversation: "" });
  useLayoutEffect(() => {
    latest.current = { runId, replaceable, conversation: conversationIdentity(store.getState()) };
  });
  // Index this header under its current run within its log, and claim a handoff waiting for that run.
  useLayoutEffect(() => {
    const log = sectionRef.current?.closest<HTMLElement>('[role="log"]');
    if (!log) return;
    const registry = runFocusRegistry(log);
    const headers = registry.headers.get(runId) ?? new Set();
    headers.add(triggerRef);
    registry.headers.set(runId, headers);
    const pending = registry.pending.get(runId);
    if (pending && triggerRef.current) {
      registry.pending.delete(runId);
      const onOwnFallback = pending.movedToLog && document.activeElement === log;
      if (pending.conversation === conversationIdentity(store.getState()) && (focusWasDropped() || onOwnFallback)) {
        triggerRef.current.focus({ preventScroll: true });
      }
    }
    return () => {
      headers.delete(triggerRef);
      if (!headers.size && registry.headers.get(runId) === headers) registry.headers.delete(runId);
    };
  }, [runId, sectionRef, store, triggerRef]);
  // On unmount only: hand focus inside a live or settling record to the same run's next header.
  useLayoutEffect(() => {
    const section = sectionRef.current;
    const log = section?.closest<HTMLElement>('[role="log"]');
    return () => {
      const { runId: run, replaceable, conversation } = latest.current;
      if (!replaceable || !section || !log || !section.contains(document.activeElement)) return;
      if (conversationIdentity(store.getState()) !== conversation) return;
      const registry = runFocusRegistry(log);
      const successor = [...(registry.headers.get(run) ?? [])]
        .filter((ref) => ref !== triggerRef)
        .map((ref) => ref.current)
        .find((header) => header?.isConnected);
      if (successor) {
        successor.focus({ preventScroll: true });
        return;
      }
      const handoff = { conversation, movedToLog: false };
      registry.pending.set(run, handoff);
      window.requestAnimationFrame(() => {
        if (registry.pending.get(run) !== handoff || !log.isConnected || !focusWasDropped()) return;
        if (conversationIdentity(store.getState()) !== conversation) return;
        handoff.movedToLog = true;
        log.focus({ preventScroll: true });
      });
      window.setTimeout(() => {
        if (registry.pending.get(run) === handoff) registry.pending.delete(run);
      }, HANDOFF_WINDOW_MS);
    };
  }, [sectionRef, store, triggerRef]);
}

/**
 * Live runs open by default and can be folded to a one-line summary of the current task; a settled
 * run starts folded and remembers its disclosure per run in the store. The live choice is local, so
 * settling collapses exactly once (in place, or by remounting as the persisted record) and later
 * updates never re-collapse or re-open it. `settling` marks a finished run shown until its persisted
 * record replaces it; like a live record, it hands focus to that successor.
 */
export function AgentWorkCard({ work, active, settling = false }: { work: Work; active: boolean; settling?: boolean }) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const runId = work.run_id || `${work.scope_type || "agent"}:${work.scope_id || ""}:${work.started_at || ""}`;
  const settledOpen = useStore((state) => state.expandedAgentRuns[runId] === true);
  const [liveDisclosure, setLiveDisclosure] = useState<{ runId: string; open: boolean } | null>(null);
  const open = active ? (liveDisclosure?.runId === runId ? liveDisclosure.open : true) : settledOpen;
  const disclosure = useDisclosure(open);
  const panelId = useId();
  const statusId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  useRunFocusHandoff(runId, active || settling, disclosure.triggerRef, sectionRef);
  const elapsedSeconds = useElapsedSeconds(work.started_at, active, runId);
  if (!hasAgentProcessSteps(work)) return null;

  const entries = processEntries(work, t);
  const failed = !active && (work.state === "error" || work.state === "needs_review");
  const approval = active && work.state === "approval";
  let current: ProcessLineEntry | undefined;
  if (active) for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]!.state === "running") { current = entries[index]; break; }
  }
  const folded = active && !open ? current : undefined;
  const summary = completedWorkSummary(entries, t);
  // A finished run can succeed overall while individual steps failed; say so without expanding.
  const failedSteps = active || failed ? 0 : entries.filter((entry) => entry.kind !== "notice" && entry.state === "failed").length;
  const label = folded
    ? folded.title
    : active ? t(approval ? "chat.work.awaitingApproval" : "chat.work.working") : failed ? t("chat.work.failed") : summary;
  const statusText = active ? agentStatusText(work, t) : "";
  const queued = Number(work.queued_count || 0);
  const waiting = active ? work.state === "replying" ? queued : Math.max(0, queued - 1) : 0;
  const meta: ReactNode[] = [];
  if (active) meta.push(<span key="steps">{t("chat.work.steps", { count: entries.filter((entry) => entry.kind !== "notice").length })}</span>);
  if (failed) meta.push(<span key="summary">{summary}</span>);
  if (failedSteps > 0) meta.push(<span key="failed-steps" className="shrink-0 text-red">{t("chat.work.failedSteps", { count: failedSteps })}</span>);
  if (waiting > 0) meta.push(<span key="waiting">{t("chat.work.waitingCount", { count: waiting })}</span>);
  if (elapsedSeconds != null) {
    const time = formatElapsed(elapsedSeconds);
    meta.push(<span key="elapsed" className="font-mono"><span className="wf-sr-only">{t("chat.work.elapsed", { time })}</span><span aria-hidden="true">{time}</span></span>);
  }
  const live = active && !approval;
  const toggle = () => {
    if (active) setLiveDisclosure({ runId, open: !open });
    else dispatch({ type: "TOGGLE_AGENT_RUN", payload: { runId, expanded: !open } });
  };
  const sign = approval
    ? <span className="flex text-orange"><Glyph name="lock" size={14} /></span>
    : failed || failedSteps > 0
      ? <span className="flex text-red"><Glyph name="warning" size={14} /></span>
      : <span className={`flex transition-colors duration-200 ${live ? "text-ink-2" : "text-ink-3"}`}><SparkleMark /></span>;
  const labelClass = "min-w-0 truncate text-[13px] font-medium";
  // Beautiful UI Thinking: sparkle, shimmering label while working, quiet summary once settled, rotating chevron.
  return <section ref={sectionRef} className="wf-trace mb-3 min-w-0 max-w-full" aria-label={t("chat.work.label")}>
    {statusText && <span id={statusId} className="wf-sr-only">{statusText}</span>}
    <button ref={disclosure.triggerRef} type="button"
      className="-mx-1.5 flex w-fit max-w-[calc(100%+12px)] min-w-0 items-center gap-2 rounded-control px-1.5 py-1 text-left transition-colors duration-100 hover:bg-hover-2"
      aria-expanded={open} aria-controls={panelId} aria-describedby={statusText ? statusId : undefined} title={statusText || undefined} onClick={toggle}>
      <span className="flex shrink-0" aria-hidden="true">{sign}</span>
      {live
        ? <Shimmer className={labelClass}>{label}</Shimmer>
        : <span className={`${labelClass} ${failed ? "text-red" : approval ? "text-ink" : "text-ink-2"}`}>{label}</span>}
      {folded?.preview && <span className={`inline-block h-5.5 min-w-0 max-w-96 shrink-[1000] truncate rounded-chip bg-field px-1.5 text-[11.5px] leading-[22px] text-ink-2 shadow-hairline${usesMonoPreview(folded) ? " font-mono" : ""}`}>{folded.preview}</span>}
      {meta.length > 0 && <span className="flex min-w-0 shrink items-center gap-1.5 truncate text-[12px] text-ink-3 tabular-nums [&>*+*]:before:mr-1.5 [&>*+*]:before:content-['·']">{meta}</span>}
      <ChevronDown className="shrink-0 text-ink-3 transition-transform duration-300" style={{ transform: open ? "rotate(180deg)" : "rotate(0)" }} />
    </button>
    <DisclosurePanel id={panelId} open={open} disclosure={disclosure}>
      <div className="relative mt-1 ml-[5px] pl-4">
        <span aria-hidden="true" className="absolute top-0 bottom-2 left-[3px] w-px bg-line forced-colors:bg-[CanvasText]" />
        <ol className="m-0 flex list-none flex-col gap-0.5 p-0 py-1" role="list">
          {entries.map((entry) => <TraceStep key={entry.key} entry={entry} />)}
        </ol>
      </div>
    </DisclosurePanel>
  </section>;
}
