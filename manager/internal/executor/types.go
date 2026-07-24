package executor

import (
	"encoding/json"
	"time"
)

type ExecutionContext struct {
	SandboxID   string `json:"sandbox_id"`
	WorkspaceID string `json:"workspace_id"`
}
type Identity struct {
	RunID            string           `json:"run_id"`
	ScopeID          string           `json:"scope_id"`
	LifecycleID      string           `json:"lifecycle_id"`
	ToolCallID       string           `json:"tool_call_id"`
	ExecutionContext ExecutionContext `json:"execution_context"`
}
type AuditRequest struct {
	Identity
	AuditID   string          `json:"audit_id"`
	Target    string          `json:"target"`
	Operation string          `json:"operation"`
	Action    string          `json:"action"`
	Arguments json.RawMessage `json:"arguments"`
	Details   map[string]any  `json:"details"`
}
type AuditReceipt struct {
	AuditID    string    `json:"audit_id"`
	ExecutorID string    `json:"executor_id"`
	Target     string    `json:"target"`
	RecordedAt time.Time `json:"recorded_at"`
}
type receiptRecord struct {
	AuditReceipt
	Identity
	Operation       string         `json:"operation"`
	Action          string         `json:"action"`
	ArgumentsSHA256 string         `json:"arguments_sha256"`
	Details         map[string]any `json:"details,omitempty"`
	CreatedAt       time.Time      `json:"created_at"`
}
type Call struct {
	Identity
	AuditID    string          `json:"audit_id"`
	ExecutorID string          `json:"executor_id"`
	Target     string          `json:"target"`
	Action     string          `json:"action"`
	Arguments  json.RawMessage `json:"arguments"`
}

type ProcessSnapshot struct {
	ID             string     `json:"id"`
	RunID          string     `json:"run_id"`
	ScopeKey       string     `json:"scope_key"`
	LifecycleID    string     `json:"lifecycle_id"`
	Target         string     `json:"target"`
	Command        string     `json:"command"`
	CWD            string     `json:"cwd"`
	PID            int        `json:"pid,omitempty"`
	Status         string     `json:"status"`
	StopConfirmed  *bool      `json:"stop_confirmed,omitempty"`
	ExitCode       *int       `json:"exit_code,omitempty"`
	Stdout         string     `json:"stdout"`
	Stderr         string     `json:"stderr"`
	StartedAt      time.Time  `json:"started_at"`
	FinishedAt     *time.Time `json:"finished_at,omitempty"`
	Background     bool       `json:"background"`
	UpdateBehavior string     `json:"update_behavior,omitempty"`
}

type terminalArguments struct {
	Command        string `json:"command"`
	CWD            string `json:"cwd,omitempty"`
	TimeoutMS      int    `json:"timeout_ms,omitempty"`
	Background     bool   `json:"background,omitempty"`
	UpdateBehavior string `json:"update_behavior,omitempty"`
}
type processArguments struct {
	ProcessID string `json:"process_id,omitempty"`
	Input     string `json:"input,omitempty"`
}
type fileReadArguments struct {
	Path   string `json:"path"`
	Offset int64  `json:"offset,omitempty"`
	Limit  int64  `json:"limit,omitempty"`
}
type fileWriteArguments struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}
type filePatchArguments struct {
	Path                 string `json:"path"`
	OldText              string `json:"old_text"`
	NewText              string `json:"new_text"`
	ExpectedReplacements int    `json:"expected_replacements,omitempty"`
}
type fileSearchArguments struct {
	Path          string `json:"path,omitempty"`
	Query         string `json:"query"`
	Regex         bool   `json:"regex,omitempty"`
	CaseSensitive bool   `json:"case_sensitive,omitempty"`
	MaxResults    int    `json:"max_results,omitempty"`
}

type ScopeIdentity struct {
	ScopeID          string           `json:"scope_id"`
	LifecycleID      string           `json:"lifecycle_id,omitempty"`
	ExecutionContext ExecutionContext `json:"execution_context"`
	SinceRevision    string           `json:"since_revision,omitempty"`
}
type RunIdentity struct {
	RunID            string           `json:"run_id"`
	ScopeID          string           `json:"scope_id"`
	LifecycleID      string           `json:"lifecycle_id"`
	ExecutionContext ExecutionContext `json:"execution_context"`
}
