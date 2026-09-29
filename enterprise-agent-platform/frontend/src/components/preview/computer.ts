import type {
  ActivityStep,
  AgentStatus,
  AgentWork,
  ComputerFileClue,
  ComputerMode,
  ComputerPresentClue,
  ComputerProjection,
  ComputerSearchHit,
} from "../../types";

export const COMPUTER_FILE_TOOLS = new Set(["read_file", "write_file", "patch_file"]);
export const COMPUTER_SEARCH_TOOLS = new Set(["web", "search_files"]);
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
  runId: string;
  startedAt: number | null;
  mode: ComputerMode | null;
  latestStep?: ActivityStep | null;
  file: ComputerFileClue | null;
  searchHits: ComputerSearchHit[];
  searchTool: string;
  present: ComputerPresentClue | null;
  /** The current resource is no longer available. */
  unavailable?: boolean;
  /** False keeps completed terminal output local without polling expired processes. */
  terminalPolling?: boolean;
}

const EMPTY_SURFACE: ComputerSurface = {
  visible: false,
  live: false,
  runId: "",
  startedAt: null,
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

export function deriveComputerSurface({
  status,
  availability,
}: {
  status: AgentStatus | null | undefined;
  availability: ComputerAvailability;
}): ComputerSurface {
  const live = status?.state === "replying" || status?.state === "approval";
  const runId = String(status?.run_id || "");
  const rawStartedAt = Number(status?.started_at);
  const startedAt = Number.isFinite(rawStartedAt) && rawStartedAt > 0
    ? rawStartedAt
    : null;
  const projected = status?.computer;
  const liveStep = latestComputerStep(status);
  const liveMode = projected?.mode || computerModeFromStep(liveStep);
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
  const present = currentPresent;

  if (live) {
    return {
      visible: true,
      live: true,
      runId,
      startedAt,
      mode: liveMode,
      latestStep: liveStep,
      file,
      searchHits,
      searchTool,
      present,
    };
  }

  // Available resources remain explicitly accessible, but never create automatic PiP.
  const mode: ComputerMode | null = availability.browserActive ? "browser"
    : availability.runningTerminalCount > 0 ? "terminal"
    : availability.presentAvailable ? "present" : null;
  return mode ? {...EMPTY_SURFACE, visible: true, mode} : EMPTY_SURFACE;
}

