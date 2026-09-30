package executor

import (
	"encoding/json"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/sandbox"
)

type ExecutionContext struct {
	SandboxID   string `json:"sandbox_id"`
	WorkspaceID string `json:"workspace_id"`
	Profile     string `json:"profile,omitempty"`
}

// Agent is the legacy profile; omit it from durable identity records.
func storedProfile(profile string) string {
	if profile == "agent" {
		return ""
	}
	return profile
}

func sameProfile(left, right string) bool {
	l, leftErr := sandbox.NormalizeProfile(left)
	r, rightErr := sandbox.NormalizeProfile(right)
	return leftErr == nil && rightErr == nil && l == r
}

func sameExecutionContext(left, right ExecutionContext) bool {
	return left.SandboxID == right.SandboxID && left.WorkspaceID == right.WorkspaceID &&
		sameProfile(left.Profile, right.Profile)
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
	RunID         string     `json:"run_id"`
	ScopeKey      string     `json:"scope_key"`
	LifecycleID   string     `json:"lifecycle_id"`
	Target        string     `json:"target"`
	Command       string     `json:"command"`
	CWD           string     `json:"cwd"`
	Status        string     `json:"status"`
	StopConfirmed *bool      `json:"stop_confirmed,omitempty"`
	ExitCode      *int       `json:"exit_code,omitempty"`
	Stdout        string     `json:"stdout"`
	Stderr        string     `json:"stderr"`
	StartedAt     time.Time  `json:"started_at"`
	FinishedAt    *time.Time `json:"finished_at,omitempty"`
	Background    bool       `json:"background"`
}

type terminalArguments struct {
	Command    string `json:"command"`
	CWD        string `json:"cwd,omitempty"`
	TimeoutMS  int    `json:"timeout_ms,omitempty"`
	Background bool   `json:"background,omitempty"`
	// Runtime-owned presentation metadata is derived from the consumed audit
	// record and never accepted from the executor protocol body.
	DisplayCommand string `json:"-"`
	PrivateOutput  bool   `json:"-"`
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
type RunIdentity struct {
	RunID            string           `json:"run_id"`
	ScopeID          string           `json:"scope_id"`
	LifecycleID      string           `json:"lifecycle_id"`
	ExecutionContext ExecutionContext `json:"execution_context"`
}
