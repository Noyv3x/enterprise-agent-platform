export type ProcessStatus = "running" | "completed" | "failed" | "cancelled" | "orphaned";

export function processStatusActive(status: ProcessStatus): boolean {
  return status === "running" || status === "orphaned";
}

export interface ProcessSnapshot {
  id: string;
  run_id: string;
  scope_key: string;
  lifecycle_id: string;
  command: string;
  cwd: string;
  pid?: number;
  status: ProcessStatus;
  stop_confirmed?: boolean;
  exit_code?: number | null;
  stdout: string;
  stderr: string;
  started_at: string;
  finished_at?: string;
  background: boolean;
}

/** Per-call wait state. This flag is never stored in Manager process state. */
export interface ProcessWaitResult extends ProcessSnapshot {
  wait_timed_out: boolean;
}

export interface ProcessPreview {
  id: string;
  title: string;
  command: string;
  cwd: string;
  output: string;
  status: ProcessSnapshot["status"];
  running: boolean;
  exit_code?: number | null;
  started_at: string;
  updated_at: string;
  finished_at?: string;
  truncated: boolean;
}

export type ProcessPreviewResult =
  | { processes: ProcessPreview[]; revision: string }
  | { processes: []; revision: string; unchanged: true };

export interface ProcessPreviewSummary {
  running_terminal_count: number;
}
