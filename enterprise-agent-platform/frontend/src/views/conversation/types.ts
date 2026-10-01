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
}

export interface MessagePage {
  messages: Message[];
  next_before_id: number | null;
  /** Event watermark: connecting SSE with `after=last_seq` replays only the active run. */
  last_seq: number;
  compaction: Compaction | null;
}

/** The agent turn currently streaming over SSE, in arrival order; it becomes a persisted message at `run_end`. */
export interface LiveRun {
  items: WorkItem[];
  /** epoch ms the first event of this run arrived */
  startedAt: number;
  notice: "retry" | "compaction" | null;
}

export interface ChatConversation {
  id: string;
  user_id: number;
  title: string;
  model_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: null;
}

export interface ChatModels {
  allowed_models: string[];
  default_model_id: string;
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
