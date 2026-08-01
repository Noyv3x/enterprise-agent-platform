//go:build linux

// Package handoffowner coordinates the one-time technical namespace handoff.
//
// It contains no Docker, filesystem relocation, systemd, gateway, or listener
// implementation. Those host effects are injected through narrow interfaces,
// while this package owns routing, durable phase ordering, replay, rollback,
// and receipt-grade observations.
package handoffowner

import (
	"context"
	"errors"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofffd"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

var (
	// ErrOrdinaryManifest is returned before any host inspection or mutation.
	// Ordinary releases belong to the normal update owner, never this package.
	ErrOrdinaryManifest = errors.New("ordinary release manifest is not a namespace handoff")
	// ErrHandoffInProgress means a differently bound nonterminal transaction
	// already owns the deployment-wide handoff singleton.
	ErrHandoffInProgress = errors.New("another namespace handoff is already in progress")
	// ErrNoHandoff means startup recovery found no nonterminal transaction.
	ErrNoHandoff = errors.New("no nonterminal namespace handoff exists")
)

// BridgeRequest supplies the already downloaded, immutable bridge manifest.
// ManifestPath and ManifestSHA256 identify the exact bytes retained for
// recovery; the coordinator never downloads or rewrites that artifact.
type BridgeRequest struct {
	Manifest       release.Manifest
	ManifestPath   string
	ManifestSHA256 string
}

// PreflightPlan is the complete read-only deployment observation used to
// create the immutable journal binding. HostDriver.Preflight must not create,
// stop, reserve, download, or mutate anything.
type PreflightPlan struct {
	Source   handoff.SourceBinding
	Target   handoff.TargetBinding
	Evidence handoff.Evidence
	Runtime  RuntimeObservation
	// Admission is acquired by HostDriver.Preflight while the Store already
	// holds the handoff global lock. The coordinator keeps it through the
	// atomic planned-journal write, then closes it. This is the only supported
	// handoff -> ordinary-runtime lock order for beginning a bridge.
	Admission RuntimeObservationLease
}

// RuntimeObservation is a secret-free, authoritative observation of the live
// Manager. It is deliberately explicit: a boolean "healthy" is insufficient
// evidence for release promotion.
type RuntimeObservation struct {
	Profile                    identity.Profile `json:"profile"`
	Generation                 string           `json:"generation"`
	ManagerSHA256              string           `json:"manager_sha256"`
	Architecture               string           `json:"architecture"`
	Idle                       bool             `json:"idle"`
	Maintenance                bool             `json:"maintenance"`
	ActiveOperationID          string           `json:"active_operation_id"`
	FinalizePendingOperationID string           `json:"finalize_pending_operation_id"`
	CandidatePresent           bool             `json:"candidate_present"`
	ActivationPresent          bool             `json:"activation_present"`
	WatchdogCount              int              `json:"watchdog_count"`
	ActiveExecutionCount       int              `json:"active_execution_count"`
	AuthenticatedChannelCheck  time.Time        `json:"authenticated_channel_check_at"`
}

// RuntimeObservationLease holds the Manager's ordinary-operation admission
// boundary while receipt evidence is read. The coordinator already holds the
// handoff global flock before acquiring this lease; implementations must not
// reacquire that flock, and must prevent a new operation, activation,
// watchdog, or execution from starting until Close.
type RuntimeObservationLease interface {
	Observe(context.Context) (RuntimeObservation, error)
	Close() error
}

// ReceiptObservation is the exact evidence projection consumed by the local
// deployment receipt signer. This package does not hold a signing key and does
// not sign or serialize the release-transition receipt itself.
type ReceiptObservation struct {
	ObservedGeneration string `json:"observed_generation"`
	ProfileID          string `json:"profile_id"`
	Capability         string `json:"capability"`
	Status             string `json:"status"`
	Architecture       string `json:"architecture"`
	ManagerSHA256      string `json:"manager_sha256"`
	EvidenceSHA256     string `json:"evidence_sha256"`
}

// StartupRecovery is the fail-closed startup projection for a nonterminal
// handoff. Manager startup must block ordinary update ownership whenever
// Active is true and let the persistent helper resume the journal.
type StartupRecovery struct {
	Active                    bool
	TransactionID             string
	Status                    handoff.Status
	Phase                     handoff.Phase
	DesiredOutcome            handoff.DesiredOutcome
	BlockOrdinaryOperations   bool
	MaintenanceRequired       bool
	PersistentHelperRequired  bool
	SourceParticipantRequired bool
	TargetParticipantRequired bool
}

// HostDriver is the exact host integration surface required by the handoff
// owner. Every mutating method must be idempotent and must verify that an
// existing effect belongs to the supplied journal before accepting it.
// Methods must never infer ownership from names alone.
type HostDriver interface {
	// Preflight performs only read-only checks and returns the facts that will
	// become the journal's immutable binding. It must acquire Admission before
	// observing Runtime or any mutable deployment fact; on an error it must
	// release any lease it acquired itself.
	Preflight(context.Context, BridgeRequest, identity.Profile, identity.Profile) (PreflightPlan, error)

	// ArmPersistentHelper installs/enables/starts (or proves) the owner-only
	// persistent helper. It runs only after Journal.Create has been synced.
	ArmPersistentHelper(context.Context, handoff.Journal) error
	// VerifyPersistentHelper proves the current PID/boot against the immutable
	// unit, running inode, executable/argv digests, cgroup, and journal binding,
	// but returns only the static identity that remains valid after restart.
	VerifyPersistentHelper(context.Context, handoff.Journal) (handoff.HelperEvidence, error)
	// FinalizePersistentHelper proves the calling helper against a durable
	// terminal journal and disables only its boot enablement. The helper must
	// then return and exit normally; a stable Manager performs later static
	// cleanup after proving the unit inactive. It must be safe to replay.
	FinalizePersistentHelper(context.Context, handoff.Journal) error

	ReserveAdmission(context.Context, handoff.Journal) error
	DrainAndStopWriters(context.Context, handoff.Journal) error
	CreateSnapshot(context.Context, handoff.Journal) (handoff.Snapshot, error)
	FenceSource(context.Context, handoff.Journal) error
	StageTarget(context.Context, handoff.Journal) error
	TransformData(context.Context, handoff.Journal) error
	// StartTarget runs while the coordinator holds the global handoff lease.
	// It must pass the target Router a one-shot, read-only snapshot/capability
	// derived from this Journal over an owner-authenticated channel; the child
	// must not call Store.Load and deadlock by reacquiring the global lease.
	StartTarget(context.Context, handoff.Journal, handoff.StartupLease) error
	ProbeTarget(context.Context, handoff.Journal) error
	// TargetAcknowledgement obtains a proof produced by the target Manager;
	// the helper implementation must not synthesize or sign it.
	TargetAcknowledgement(context.Context, handoff.Journal) (handoff.TargetAck, error)
	RetireSource(context.Context, handoff.Journal) error
	VerifyTargetCommitBoundary(context.Context, handoff.Journal) error
	// CommitTargetPlatform is called only after the forward-only
	// target_commit_planned checkpoint. It must return Platform's durable,
	// identity-bound receipt and be safe to repeat after an uncertain response.
	CommitTargetPlatform(context.Context, handoff.Journal) (handoff.TargetPlatformCommit, error)

	StopTarget(context.Context, handoff.Journal) error
	RestoreData(context.Context, handoff.Journal) error
	// StartSource has the same lock-internal startup-capability requirement as
	// StartTarget when recovering the source after source_fenced.
	StartSource(context.Context, handoff.Journal, handoff.StartupLease) error
	// RestoreSourceBeforeFence is the abort-only source boundary. Before
	// writers were stopped it only proves that source remains the unique
	// owner; after they were stopped it idempotently restores the source fixed
	// stack and proves that ownership. If the source unit must be restarted,
	// it uses only the distinct source-abort capability derived from this
	// already-held writer lease, never the formal startup issuer.
	RestoreSourceBeforeFence(context.Context, handoff.Journal, handoff.StartupLease) error
	ReleaseAdmission(context.Context, handoff.Journal) error
	RemoveTargetStaging(context.Context, handoff.Journal) error
	VerifySourceIdentity(context.Context, handoff.Journal) error
	VerifySourcePublicReady(context.Context, handoff.Journal) error

	AcquireRuntimeObservationLease(context.Context) (RuntimeObservationLease, error)
}

type ListenerOwner string

const (
	ListenerOwnerUnknown ListenerOwner = ""
	ListenerOwnerHelper  ListenerOwner = "helper"
	ListenerOwnerSource  ListenerOwner = "source"
	ListenerOwnerTarget  ListenerOwner = "target"
)

// ListenerState is the helper's current, replay-observed public-listener
// custody. Only helper ownership carries descriptors; source/target ownership
// is accepted only after an authenticated complete-set challenge.
type ListenerState struct {
	Owner     ListenerOwner
	Listeners []handofffd.NamedListener
}

// ListenerDriver is the SCM_RIGHTS/rebind integration surface. Concrete code
// must use handofffd's closed-world wire format and the durable bind locks.
// EnsureMaintenance accepts from source, proves an allowed participant owner,
// or, after reboot, rebinds the exact configured addresses while proving the
// helper is the unique journal owner. It is called before every post-fence host
// effect so a process restart cannot silently lose the maintenance endpoint.
// Every method receives the read-only capability derived from the exact
// Helper writer lease currently held by Coordinator; a copied Journal or an
// injectable authority callback can never replace that capability.
// CommitToTarget must return an error only while the helper still owns the
// original listeners and target public writes have not opened; this makes an
// error deterministically rollback-safe. On post-crash replay CommitToTarget
// or RestoreToSource may receive a nil slice and must reconcile exact durable
// listener ownership rather than interpreting it as an empty listener set.
type ListenerDriver interface {
	EnsureMaintenance(context.Context, handoff.Journal, handoff.StartupLease, ListenerState) (ListenerState, error)
	CommitToTarget(context.Context, handoff.Journal, handoff.StartupLease, []handofffd.NamedListener) error
	RestoreToSource(context.Context, handoff.Journal, handoff.StartupLease, []handofffd.NamedListener) error
}

// Options binds the coordinator to the already resolved external journal
// store and the two compile-time identity profiles. It never reads HOME, XDG,
// executable names, environment variables, or administrator branding.
type Options struct {
	Store         *handoff.Store
	Host          HostDriver
	Listeners     ListenerDriver
	SourceProfile identity.ActiveProfile
	TargetProfile identity.Profile
	Channel       string
	GOOS          string
	GOARCH        string
	Clock         func() time.Time
}

type Coordinator struct {
	store     *handoff.Store
	host      HostDriver
	listeners ListenerDriver
	active    identity.ActiveProfile
	source    identity.Profile
	target    identity.Profile
	channel   string
	goos      string
	goarch    string
	clock     func() time.Time
}
