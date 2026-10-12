import type { ArtifactRef } from "../../api";
import type { WorkItem } from "./work";

export interface Attachment {
  id: number;
  filename: string;
  mime_type: string;
  size_bytes: number;
  url: string;
  preview_url: string | null;
}

export type MessageStatus = "queued" | "running" | "completed" | "interrupted" | "cancelled";

/** How a message sent while the agent works joins it: into the running turn when eligible, or as the next turn. */
export type SendMode = "insert" | "after_turn";

export interface Message {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  metadata: {
    status?: MessageStatus;
    error?: string;
    inserted_into?: number;
    delivery?: "pending" | "delivered";
    reply_to?: { message_id: number };
    /** assistant replies: the artifact versions their run published (platform-api.md § Artifacts) */
    artifacts?: ArtifactRef[];
    /** recorded only for after-turn messages */
    send_mode?: "after_turn";
    [key: string]: unknown;
  };
  created_at: string;
  attachments: Attachment[];
}

export interface Compaction {
  job_id: number;
  status: "queued" | "compacting" | "done" | "nothing_to_compact" | "interrupted" | "cancelled";
  reason?: string;
  error?: string;
  /** The message the operation follows in the transcript (null: before every message); absent while queued. */
  after_message_id?: number | null;
}

export interface MessagePage {
  messages: Message[];
  next_before_id: number | null;
  /** Event watermark: connecting SSE with `after=last_seq` replays only the active run. */
  last_seq: number;
  compaction: Compaction | null;
}

/** One tool call as the computer panel sees it: streamed input and live output, beyond the work trace's final record. */
export interface ToolCall {
  id: string;
  name: string;
  /** preparing: the model is still writing the call; running: executing; the rest are final */
  status: "preparing" | "running" | "done" | "error" | "cancelled";
  /** while preparing: parsed from `input` so far; from tool_start on: the authoritative arguments */
  args: Record<string, unknown>;
  /** raw argument JSON as generated (empty for calls restored from a persisted trace) */
  input: string;
  /** live output while running; the final output once done */
  output: string;
  /** the live output hit the cap or the Runtime's limit; the final output is authoritative */
  truncated: boolean;
  /** tool_output events arrived, so tool_update partials no longer replace the output */
  streamed: boolean;
  /** unified diff of an edit's result (tool_end details) */
  diff: string;
}

/** The agent turn currently streaming over SSE, in arrival order; it becomes a persisted message at `run_end`. */
export interface LiveRun {
  items: WorkItem[];
  /** index of the explicitly open reasoning block; null for older delta-only streams */
  thinkingIndex: number | null;
  /** the run's tool calls with streaming input/output, for the computer panel only */
  calls: ToolCall[];
  /** epoch ms the first event of this run arrived */
  startedAt: number;
  notice: "retry" | "compaction" | null;
  /** artifact versions published so far (SSE `artifact`), one per artifact, newest version */
  artifacts: ArtifactRef[];
}

/** A finished run's streamed calls, keyed by the assistant message the run became (run_end's message). */
export interface LastRun {
  messageId: number;
  calls: ToolCall[];
}

/** A run the computer panel can show: the live run, or a finished one by its assistant message id. */
export type RunRef = "live" | number;

/** One step of a run, as selected in the computer panel or from the conversation. */
export interface StepRef {
  run: RunRef;
  callId: string;
}

export interface ChatConversation {
  id: string;
  user_id: number;
  title: string;
  created_at: string;
  updated_at: string;
  deleted_at: null;
}

export interface BrowserTab {
  tabId: string;
  url: string;
  title?: string;
}

export interface BrowserLease {
  holder_user_id: number;
  expires_at: string;
}

export interface WorkspaceFile {
  name: string;
  path: string;
  is_dir: boolean;
  size_bytes: number;
}

/** The connector an MCP card is about (SSE `mcp_action_required`, `mcp_elicitation`). */
export interface McpConnectorRef {
  id: number;
  name: string;
  label: string;
  scope?: "org" | "personal";
}

/** Where an action card's credentials would go and who added the connector. The label is free text anyone adding a
 * connector chooses, so the card shows the destination itself: the URL origin of a remote connector, or the command
 * of a local one. `pending_confirmation`: added by the AI or an import and not yet confirmed by the user, so no
 * credential is asked for before 确认并启用. */
export interface McpActionConnector extends McpConnectorRef {
  transport: "http" | "sse" | "stdio";
  destination: string;
  source: "ai" | "import" | "manual";
  state: "pending_confirmation" | "active";
}

/** SSE `mcp_action_required`: the user must confirm a connector the AI or an import added (`confirm`, when nothing
 * else is needed yet), sign in to it (OAuth) or enter its secret values; the AI never asks for them in the chat.
 * `keys` are the missing secret names. */
export interface McpActionRequired {
  connector: McpActionConnector;
  kind: "confirm" | "oauth" | "secrets";
  keys?: string[];
}

/** SSE `mcp_elicitation`: a connector asks the user who started the run for input, through a form built from
 * `schema` or by visiting `url`. Platform cancels it at `expires_at`. */
export interface McpElicitation {
  id: string;
  user_id: number;
  connector: McpConnectorRef;
  mode: "form" | "url";
  message: string;
  schema?: Record<string, unknown> | null;
  url?: string | null;
  expires_at: string;
}

/** How an elicitation ended: an answer (`accept`, `decline`, `cancel`), Platform's timeout, or `gone` when Platform
 * no longer knows it (answered elsewhere or expired) by the time this browser answered. */
export type ElicitationOutcome = "accept" | "decline" | "cancel" | "timeout" | "gone";

export interface ElicitationState {
  request: McpElicitation;
  outcome: ElicitationOutcome | null;
}
