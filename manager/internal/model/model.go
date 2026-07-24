package model

import "time"

type PublicState string

const (
	StateIdle            PublicState = "idle"
	StateWaitingForTasks PublicState = "waiting_for_tasks"
	StateUpdating        PublicState = "updating"
	StateFailed          PublicState = "failed"
)

type OperationKind string

const (
	OperationInstall  OperationKind = "install"
	OperationUpdate   OperationKind = "update"
	OperationRestart  OperationKind = "restart"
	OperationRollback OperationKind = "rollback"
	OperationRepair   OperationKind = "repair"
)

type OperationPhase string

const (
	PhaseValidating   OperationPhase = "validating"
	PhasePulling      OperationPhase = "pulling"
	PhasePreparing    OperationPhase = "preparing"
	PhaseDraining     OperationPhase = "draining"
	PhaseSnapshotting OperationPhase = "snapshotting"
	PhaseMigrating    OperationPhase = "migrating"
	PhaseStarting     OperationPhase = "starting"
	PhaseProbing      OperationPhase = "probing"
	PhaseCommitting   OperationPhase = "committing"
	PhaseRollingBack  OperationPhase = "rolling_back"
)

type OperationStatus string

const (
	OperationPending   OperationStatus = "pending"
	OperationRunning   OperationStatus = "running"
	OperationSucceeded OperationStatus = "succeeded"
	OperationFailed    OperationStatus = "failed"
)

type Generation struct {
	ID                   string            `json:"id"`
	ManifestPath         string            `json:"manifest_path,omitempty"`
	SourceCommit         string            `json:"source_commit,omitempty"`
	DatabaseVersion      int               `json:"database_version,omitempty"`
	Images               map[string]string `json:"images,omitempty"`
	RollbackSnapshotPath string            `json:"rollback_snapshot_path,omitempty"`
	ActivatedAt          time.Time         `json:"activated_at,omitempty"`
}

type ManagerState struct {
	SchemaVersion              int            `json:"schema_version"`
	Generation                 uint64         `json:"generation"`
	PublicState                PublicState    `json:"public_state"`
	Phase                      OperationPhase `json:"phase,omitempty"`
	Current                    *Generation    `json:"current,omitempty"`
	Previous                   *Generation    `json:"previous,omitempty"`
	Candidate                  *Generation    `json:"candidate,omitempty"`
	ActiveOperationID          string         `json:"active_operation_id,omitempty"`
	FinalizePendingOperationID string         `json:"finalize_pending_operation_id,omitempty"`
	Maintenance                bool           `json:"maintenance"`
	LastError                  string         `json:"last_error,omitempty"`
	RetryAfterSeconds          int            `json:"retry_after_seconds,omitempty"`
	HeartbeatAt                time.Time      `json:"heartbeat_at"`
	UpdatedAt                  time.Time      `json:"updated_at"`
}

func NewState(now time.Time) ManagerState {
	return ManagerState{
		SchemaVersion: 1,
		PublicState:   StateIdle,
		HeartbeatAt:   now.UTC(),
		UpdatedAt:     now.UTC(),
	}
}

type PhaseEvent struct {
	Phase OperationPhase `json:"phase"`
	At    time.Time      `json:"at"`
	Note  string         `json:"note,omitempty"`
}

type Operation struct {
	SchemaVersion        int             `json:"schema_version"`
	ID                   string          `json:"id"`
	Kind                 OperationKind   `json:"kind"`
	IdempotencyKey       string          `json:"idempotency_key"`
	Attempt              int             `json:"attempt"`
	ExpectedGeneration   uint64          `json:"expected_generation"`
	TargetManifestURL    string          `json:"target_manifest_url,omitempty"`
	ExpectedSourceCommit string          `json:"expected_source_commit,omitempty"`
	TargetGeneration     string          `json:"target_generation,omitempty"`
	Status               OperationStatus `json:"status"`
	Finalized            bool            `json:"finalized"`
	Retryable            bool            `json:"retryable,omitempty"`
	Phase                OperationPhase  `json:"phase"`
	SnapshotPath         string          `json:"snapshot_path,omitempty"`
	Error                string          `json:"error,omitempty"`
	History              []PhaseEvent    `json:"history"`
	CreatedAt            time.Time       `json:"created_at"`
	UpdatedAt            time.Time       `json:"updated_at"`
	CompletedAt          *time.Time      `json:"completed_at,omitempty"`
}

type OperationRequest struct {
	Kind                 OperationKind `json:"kind"`
	IdempotencyKey       string        `json:"idempotency_key"`
	ExpectedGeneration   uint64        `json:"expected_generation"`
	ManifestURL          string        `json:"manifest_url,omitempty"`
	ExpectedSourceCommit string        `json:"expected_source_commit,omitempty"`
}
