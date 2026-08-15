import { isAgentActive } from "../../store/selectors";
import type {
  ActivityStep,
  AgentStatus,
  AgentWork,
  Attachment,
  ComputerFileClue,
  ComputerMode,
  ComputerPresentClue,
  ComputerProjection,
  ComputerSearchHit,
  Message,
} from "../../types";

export const COMPUTER_FILE_TOOLS = new Set(["read_file", "write_file", "patch_file"]);
export const COMPUTER_SEARCH_TOOLS = new Set(["web", "knowledge", "search_files"]);
export const COMPUTER_TERMINAL_TOOLS = new Set(["terminal", "process"]);
export const COMPUTER_BROWSER_TOOLS = new Set(["browser"]);
const HTML_SUFFIX = /\.(html|htm)$/i;

export interface ComputerAvailability {
  browserActive: boolean;
  runningTerminalCount: number;
  presentAvailable: boolean;
  loading: boolean;
  error: string;
}

export interface ComputerSurface {
  visible: boolean;
  live: boolean;
  mode: ComputerMode | null;
  latestStep?: ActivityStep | null;
  file: ComputerFileClue | null;
  searchHits: ComputerSearchHit[];
  searchTool: string;
  present: ComputerPresentClue | null;
}

const EMPTY_SURFACE: ComputerSurface = {
  visible: false,
  live: false,
  mode: null,
  file: null,
  searchHits: [],
  searchTool: "",
  present: null,
};

function toolName(step: ActivityStep | null | undefined): string {
  return String(step?.tool || step?.label || "").trim().toLowerCase();
}

export function isComputerTool(tool: string): boolean {
  const name = tool.trim().toLowerCase();
  return (
    COMPUTER_FILE_TOOLS.has(name)
    || COMPUTER_SEARCH_TOOLS.has(name)
    || COMPUTER_TERMINAL_TOOLS.has(name)
    || COMPUTER_BROWSER_TOOLS.has(name)
  );
}

export function isHtmlWorkspacePath(value: string | undefined): boolean {
  return Boolean(value && HTML_SUFFIX.test(value.trim()));
}

export function isHtmlAttachment(attachment: Attachment | undefined): boolean {
  if (!attachment) return false;
  const filename = String(attachment.filename || "");
  const mime = String(attachment.mime_type || "").split(";", 1)[0].trim().toLowerCase();
  return HTML_SUFFIX.test(filename) || mime === "text/html" || mime === "application/xhtml+xml";
}

function stepSequence(step: ActivityStep): number {
  const value = Number(step.updated_sequence ?? step.sequence ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function stepRevision(step: ActivityStep): string {
  return [
    String(step.tool_call_id || toolName(step) || "tool"),
    String(stepSequence(step)),
    String(step.tool_status || "running"),
  ].join(":");
}

export function latestComputerStep(work: AgentWork | AgentStatus | null | undefined): ActivityStep | null {
  let latest: ActivityStep | null = null;
  let latestSequence = -1;
  for (const step of work?.activity || []) {
    if (!isComputerTool(toolName(step))) continue;
    const sequence = stepSequence(step);
    if (!latest || sequence >= latestSequence) {
      latest = step;
      latestSequence = sequence;
    }
  }
  return latest;
}

export function computerModeFromStep(step: ActivityStep | null): ComputerMode | null {
  if (!step) return null;
  const tool = toolName(step);
  if (COMPUTER_FILE_TOOLS.has(tool)) {
    const workspacePath = String(step.parameters?.workspace_path || "");
    const target = String(step.parameters?.target || "sandbox").toLowerCase();
    if (
      (tool === "write_file" || tool === "patch_file")
      && target !== "host"
      && isHtmlWorkspacePath(workspacePath)
    ) {
      return "present";
    }
    return "file";
  }
  if (COMPUTER_SEARCH_TOOLS.has(tool)) return "search";
  if (COMPUTER_TERMINAL_TOOLS.has(tool)) return "terminal";
  if (COMPUTER_BROWSER_TOOLS.has(tool)) return "browser";
  return null;
}

function fileClueFromStep(step: ActivityStep | null): ComputerFileClue | null {
  if (!step || !COMPUTER_FILE_TOOLS.has(toolName(step))) return null;
  const parameters = step.parameters || {};
  return {
    tool: toolName(step),
    path: parameters.path != null ? String(parameters.path) : undefined,
    workspace_path: parameters.workspace_path != null ? String(parameters.workspace_path) : undefined,
    target: parameters.target != null ? String(parameters.target) : "sandbox",
    status: String(step.tool_status || "running"),
    tool_call_id: step.tool_call_id,
    sequence: step.sequence,
    updated_sequence: step.updated_sequence,
    revision: stepRevision(step),
  };
}

function presentClueFromStep(step: ActivityStep | null): ComputerPresentClue | null {
  if (!step || !COMPUTER_FILE_TOOLS.has(toolName(step))) return null;
  const tool = toolName(step);
  const parameters = step.parameters || {};
  const workspacePath = String(parameters.workspace_path || "");
  const target = String(parameters.target || "sandbox").toLowerCase();
  if (
    (tool !== "write_file" && tool !== "patch_file")
    || target === "host"
    || !isHtmlWorkspacePath(workspacePath)
  ) return null;
  return {
    workspace_path: workspacePath,
    status: String(step.tool_status || "running"),
    tool_call_id: step.tool_call_id,
    sequence: step.sequence,
    updated_sequence: step.updated_sequence,
    revision: stepRevision(step),
  };
}

function presentFromProjection(computer: ComputerProjection | undefined): ComputerPresentClue | null {
  const present = computer?.present;
  if (!present) return null;
  if (present.workspace_path || present.attachment_id != null) return present;
  return null;
}

export function presentClueFromMessages(messages: Message[]): ComputerPresentClue | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.author_type !== "agent") continue;
    if (message.metadata?.needs_review) continue;
    const work = message.metadata?.agent_work;
    if (work && work.state && work.state !== "complete") continue;
    const attachments = message.attachments || [];
    for (let attachmentIndex = attachments.length - 1; attachmentIndex >= 0; attachmentIndex -= 1) {
      const attachment = attachments[attachmentIndex];
      if (isHtmlAttachment(attachment)) {
        return {
          attachment_id: attachment.id,
          status: "completed",
          revision: `message:${String(message.id)}:attachment:${String(attachment.id)}`,
        };
      }
    }
    const step = latestComputerStep(work);
    const workspacePath = String(step?.parameters?.workspace_path || "");
    if (
      step
      && (toolName(step) === "write_file" || toolName(step) === "patch_file")
      && String(step.parameters?.target || "sandbox") !== "host"
      && isHtmlWorkspacePath(workspacePath)
    ) {
      return {
        workspace_path: workspacePath,
        status: String(step.tool_status || "completed"),
        tool_call_id: step.tool_call_id,
        sequence: step.sequence,
        updated_sequence: step.updated_sequence,
        revision: stepRevision(step),
      };
    }
  }
  return null;
}

function lastCompletedComputerMode(messages: Message[]): ComputerMode | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.author_type !== "agent") continue;
    const mode = computerModeFromStep(latestComputerStep(message.metadata?.agent_work));
    if (mode) return mode;
  }
  return null;
}

export function deriveComputerSurface({
  status,
  messages,
  availability,
}: {
  status: AgentStatus | null | undefined;
  messages: Message[];
  availability: ComputerAvailability;
}): ComputerSurface {
  const live = isAgentActive(status);
  const projected = status?.computer;
  const liveStep = latestComputerStep(status);
  const liveMode = projected?.mode || computerModeFromStep(liveStep);
  const liveWork = Boolean(live && (liveMode || projected));
  const stepFile = fileClueFromStep(liveStep);
  const file = projected?.file
    ? { ...(stepFile || {}), ...projected.file }
    : stepFile;
  const searchHits = projected?.search?.hits || [];
  const searchTool = projected?.search?.tool || "";
  const stepPresent = presentClueFromStep(liveStep);
  const projectedPresent = presentFromProjection(projected);
  const currentPresent = projectedPresent
    ? { ...(stepPresent || {}), ...projectedPresent }
    : stepPresent;
  const historicalPresent = presentClueFromMessages(messages);
  const availabilityUnconfirmed = availability.loading || Boolean(availability.error);
  const present = currentPresent || (
    availability.presentAvailable || availabilityUnconfirmed
      ? historicalPresent
      : null
  );
  const presentReadable = availability.presentAvailable || Boolean(present);
  const hasClues = liveWork || Boolean(present);

  if (liveWork) {
    let mode = liveMode;
    if (mode === "browser" && !availability.loading && !availability.browserActive) {
      mode = file ? "file" : searchHits.length ? "search" : presentReadable ? "present" : availability.runningTerminalCount > 0 ? "terminal" : "browser";
    }
    return {
      visible: true,
      live: true,
      mode: mode || "file",
      latestStep: liveStep,
      file,
      searchHits,
      searchTool,
      present,
    };
  }

  const keepAfterRun = availability.browserActive
    || availability.runningTerminalCount > 0
    || availability.presentAvailable
    || Boolean(present && (availability.loading || availability.error));
  if (!keepAfterRun && !hasClues) return EMPTY_SURFACE;
  if (!keepAfterRun && !availability.loading && !availability.error) return EMPTY_SURFACE;
  if (!keepAfterRun && availability.loading && !hasClues) return EMPTY_SURFACE;

  const lastMode = lastCompletedComputerMode(messages);
  let mode: ComputerMode | null = null;
  if (lastMode === "browser" && availability.browserActive) mode = "browser";
  else if (lastMode === "terminal" && availability.runningTerminalCount > 0) mode = "terminal";
  else if ((lastMode === "present" || lastMode === "file") && presentReadable) mode = "present";
  else if (availability.browserActive) mode = "browser";
  else if (availability.runningTerminalCount > 0) mode = "terminal";
  else if (presentReadable) mode = "present";

  if (!mode) {
    if (availability.loading || availability.error) {
      return {
        visible: hasClues,
        live: false,
        mode: lastMode === "present" || lastMode === "file" ? "present" : lastMode,
        latestStep: liveStep,
        file,
        searchHits,
        searchTool,
        present,
      };
    }
    return EMPTY_SURFACE;
  }

  return {
    visible: true,
    live: false,
    mode,
    latestStep: liveStep,
    file,
    searchHits,
    searchTool,
    present,
  };
}
