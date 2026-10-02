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

export interface Message {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  metadata: { status?: MessageStatus; error?: string; [key: string]: unknown };
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
  /** the run's tool calls with streaming input/output, for the computer panel only */
  calls: ToolCall[];
  /** epoch ms the first event of this run arrived */
  startedAt: number;
  notice: "retry" | "compaction" | null;
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
