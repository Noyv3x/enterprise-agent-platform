//go:build linux

// Package handoffhelper implements the persistent-helper half of the
// technical namespace handoff. It is deliberately constructed for one
// transaction and cannot perform source-Manager preflight or helper arming.
package handoffhelper

import (
	"context"
	"errors"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffhost"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffstartup"
)

var (
	ErrSourceOwnerOnly = errors.New("operation is owned by the stable source Manager, not the persistent handoff helper")
	ErrWrongPhase      = errors.New("persistent helper operation is not allowed in this handoff phase")
	ErrOwnership       = errors.New("persistent helper does not own the supplied handoff journal")
	ErrDataUnavailable = errors.New("production handoff data transition is unavailable")
)

// Operation is the closed, immutable projection given to helper-side host
// adapters. It contains no Store, writer lease, token, or ambient profile
// selector. Journal values are copied before every call.
type Operation struct {
	TransactionID        string
	TransactionDirectory string
	Revision             uint64
	BindingSHA256        string
	Status               handoff.Status
	DesiredOutcome       handoff.DesiredOutcome
	Phase                handoff.Phase
	Release              handoff.ReleaseBinding
	Source               handoff.SourceBinding
	Target               handoff.TargetBinding
	Evidence             handoff.Evidence
	Snapshot             *handoff.Snapshot
	Helper               handoff.HelperEvidence
	HelperProof          handoffhost.HelperProof
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

// RuntimeBoundary owns admission, writer draining, snapshots, and the source
// fixed stack. Every method must be idempotent and must either prove the
// requested transaction-owned end state or return an error.
type RuntimeBoundary interface {
	ReserveAdmission(context.Context, Operation) error
	DrainAndStopWriters(context.Context, Operation) error
	CreateSnapshot(context.Context, Operation) (handoff.Snapshot, error)
	FenceSource(context.Context, Operation) error
	RestoreSourceBeforeFence(context.Context, Operation, handoffstartup.JournalLease) error
	ReleaseAdmission(context.Context, Operation) error
}

// DataBoundary is the only capability through which this driver can stage,
// publish, restore, or delete deployment data. ValidateConfiguration must
// fail until all current machine-owned schemas have reviewed transformers and
// independent validators. TransformAndPublish must recognize both its exact
// durable staging checkpoint and an already-published target after a crash;
// RestoreData and RemoveTargetStaging may remove only objects whose durable
// identity proves they were created by this transaction.
type DataBoundary interface {
	ValidateConfiguration() error
	StageTarget(context.Context, Operation) error
	TransformAndPublish(context.Context, Operation) error
	RestoreData(context.Context, Operation) error
	RemoveTargetStaging(context.Context, Operation) error
}

type ParticipantRole string

const (
	ParticipantTarget ParticipantRole = "target"
	ParticipantSource ParticipantRole = "source"
)

// TargetPlatformCommitter is the authenticated, persistent receipt boundary
// used only after target_commit_planned has made the handoff forward-only.
type TargetPlatformCommitter interface {
	CommitHandoff(context.Context, string, string, string) (handoff.TargetPlatformCommit, error)
}

// TargetInstallationBoundary is the helper-only host installation capability.
// EnsureTarget publishes the exact target stable binary, deterministic config,
// and user-systemd unit before the target participant starts. RemoveTarget may
// run only after participant fencing and removes only the same transaction-
// proven objects; a committed transaction never calls it.
type TargetInstallationBoundary interface {
	EnsureTarget(context.Context, Operation) error
	VerifyTarget(context.Context, Operation) error
	RemoveTarget(context.Context, Operation) error
}

// StartRequest contains only journal-bound startup facts. The participant
// must route through CapabilitySocketPath before creating public side effects.
type StartRequest struct {
	Operation            Operation
	Role                 ParticipantRole
	Unit                 string
	StableBinary         string
	TransactionDirectory string
	CapabilitySocketPath string
}

// ParticipantBoundary owns source/target process and commit evidence. Start
// must honor cancellation and may return success only after the process has
// consumed the helper-issued startup capability.
type ParticipantBoundary interface {
	// InspectStarted distinguishes an absent unit from a participant that has
	// already consumed this exact startup capability. An active process that
	// cannot prove the same transaction/revision/binding must return an error,
	// never false. This is the crash-replay boundary for the one-shot issuer.
	InspectStarted(context.Context, StartRequest) (bool, error)
	// ReconcileStarted proves an already capability-routed participant and
	// idempotently restores/probes its role-bound fixed generation stack.
	ReconcileStarted(context.Context, StartRequest) error
	Start(context.Context, StartRequest) error
	ProbeTarget(context.Context, Operation) error
	TargetAcknowledgement(context.Context, Operation) (handoff.TargetAck, error)
	RetireSource(context.Context, Operation) error
	VerifyTargetCommitBoundary(context.Context, Operation) error
	CommitTargetPlatform(context.Context, Operation) (handoff.TargetPlatformCommit, error)
	StopTarget(context.Context, Operation) error
	VerifySourceIdentity(context.Context, Operation) error
	VerifySourcePublicReady(context.Context, Operation) error
}

// SourceReleaseRestorer republishes the canonical predecessor manifest and
// Compose from the transaction recovery bundle before source identity can be
// promoted out of restricted participant mode. It never overwrites differing
// bytes and is required for both pre-fence abort and rollback.
type SourceReleaseRestorer interface {
	RestoreCanonicalSourceRelease(context.Context, handoff.Journal) error
}

// HelperHost is the exact helper lifecycle surface. LinuxHost is the
// production implementation. RemoveInactive is intentionally distinct from
// Remove: stable cleanup must never stop the helper that is still running.
type HelperHost interface {
	Resolve(handoffhost.ArmRequest) (handoffhost.HelperSpec, error)
	Inspect(context.Context, handoffhost.HelperSpec) (handoffhost.HelperProof, error)
	DisableForExit(context.Context, handoffhost.HelperSpec, handoffhost.HelperProof) error
	RemoveInactive(context.Context, handoffhost.RemovalRequest) (handoffhost.RemovalResult, error)
}

type StartupIssuer interface {
	Serve(context.Context) error
	Close() error
}

type IssuerFactory interface {
	New(handoffstartup.IssuerOptions) (StartupIssuer, error)
}

type AbortSourceStartupIssuer interface {
	Serve(context.Context) (handoffstartup.AbortSourceConsumption, error)
	Close() error
}

type AbortSourceIssuerFactory interface {
	NewAbortSource(handoffstartup.AbortSourceIssuerOptions) (AbortSourceStartupIssuer, error)
}

type realAbortSourceIssuerFactory struct{}

func (realAbortSourceIssuerFactory) NewAbortSource(options handoffstartup.AbortSourceIssuerOptions) (AbortSourceStartupIssuer, error) {
	return handoffstartup.NewAbortSourceIssuer(options)
}

type realIssuerFactory struct{}

func (realIssuerFactory) New(options handoffstartup.IssuerOptions) (StartupIssuer, error) {
	return handoffstartup.NewIssuer(options)
}

// Options binds one helper process to one immutable transaction directory.
// All host paths are resolved by the caller; this package never reads HOME,
// XDG variables, branding, or a Store path.
type Options struct {
	TransactionDirectory string
	Bindings             handoffstartup.Bindings
	Runtime              RuntimeBoundary
	Data                 DataBoundary
	Participants         ParticipantBoundary
	SourceRelease        SourceReleaseRestorer
	HelperHost           HelperHost
	IssuerFactory        IssuerFactory
	CurrentPID           func() int
	Clock                func() time.Time
}

type Driver struct {
	transactionID        string
	transactionDirectory string
	bindings             handoffstartup.Bindings
	runtime              RuntimeBoundary
	data                 DataBoundary
	participants         ParticipantBoundary
	sourceRelease        SourceReleaseRestorer
	helperHost           HelperHost
	issuerFactory        IssuerFactory
	currentPID           func() int
	clock                func() time.Time
}
