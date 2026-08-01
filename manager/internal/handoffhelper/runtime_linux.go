//go:build linux

package handoffhelper

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"syscall"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffstartup"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/operation"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/sandbox"
)

type AdmissionGate interface {
	Reserve(context.Context, string) (operation.Reservation, error)
	Release(context.Context, string) error
	Health(context.Context) error
}

// GenerationStack is satisfied by driver.DockerCLI. The closed-world writer
// probe is distinct from UI health because a successful `compose stop` alone
// is not durable proof that no writer remains, and an observation error is not
// proof of absence.
type GenerationStack interface {
	StopFixed(context.Context) error
	StartFixed(context.Context, release.Manifest) error
	Probe(context.Context, release.Manifest) error
	VerifyCoreNetwork(context.Context, string) error
	VerifyFixedWritersStopped(context.Context, release.Manifest) error
	RemoveTransactionCoreNetwork(context.Context, string, string) error
}

type SnapshotBackend interface {
	Create(context.Context, string) (string, error)
	Verify(context.Context, string) error
}

type SandboxQuiescer interface {
	StopAll(context.Context, Operation) error
	VerifyStopped(context.Context, Operation) error
}

type ProductionRuntimeOptions struct {
	Gate           AdmissionGate
	SourceStack    GenerationStack
	SourceManifest release.Manifest
	Bindings       handoffstartup.Bindings
	Snapshots      SnapshotBackend
	SnapshotRoot   string
	Sandboxes      SandboxQuiescer
	Units          UnitController
	AbortIssuers   AbortSourceIssuerFactory
	PollInterval   time.Duration
}

// ProductionRuntime owns the source Platform admission, source fixed writers,
// transaction snapshot and source Manager fence. Its inputs are immutable A2
// generation objects prepared before the helper begins.
type ProductionRuntime struct {
	gate           AdmissionGate
	sourceStack    GenerationStack
	sourceManifest release.Manifest
	bindings       handoffstartup.Bindings
	snapshots      SnapshotBackend
	snapshotRoot   string
	sandboxes      SandboxQuiescer
	units          UnitController
	abortIssuers   AbortSourceIssuerFactory
	poll           time.Duration
}

func NewProductionRuntime(options ProductionRuntimeOptions) (*ProductionRuntime, error) {
	if options.Gate == nil || options.SourceStack == nil || options.Snapshots == nil || options.Sandboxes == nil || options.Units == nil {
		return nil, errors.New("production runtime dependencies are incomplete")
	}
	if !canonicalAbsolute(options.SnapshotRoot) || options.SourceManifest.ID() == "" || options.SourceManifest.SourceCommit == "" {
		return nil, errors.New("production runtime immutable generation or snapshot root is invalid")
	}
	if _, err := handoffstartup.NewHelperRouter(options.Bindings); err != nil {
		return nil, fmt.Errorf("validate runtime startup bindings: %w", err)
	}
	if options.AbortIssuers == nil {
		options.AbortIssuers = realAbortSourceIssuerFactory{}
	}
	if options.PollInterval == 0 {
		options.PollInterval = 100 * time.Millisecond
	}
	if options.PollInterval < 10*time.Millisecond || options.PollInterval > time.Second {
		return nil, errors.New("runtime poll interval is outside 10ms..1s")
	}
	return &ProductionRuntime{
		gate: options.Gate, sourceStack: options.SourceStack, sourceManifest: options.SourceManifest,
		bindings:  options.Bindings,
		snapshots: options.Snapshots, snapshotRoot: options.SnapshotRoot, sandboxes: options.Sandboxes,
		units: options.Units, abortIssuers: options.AbortIssuers, poll: options.PollInterval,
	}, nil
}

func (runtime *ProductionRuntime) ReserveAdmission(ctx context.Context, operation Operation) error {
	if err := runtime.validateSourceGeneration(operation); err != nil {
		return err
	}
	reservation, err := runtime.gate.Reserve(ctx, operation.TransactionID)
	if err != nil {
		return fmt.Errorf("reserve source Platform admission: %w", err)
	}
	if !reservation.Reserved {
		return fmt.Errorf("source Platform admission remains busy: %s", reservation.Reason)
	}
	return nil
}

func (runtime *ProductionRuntime) DrainAndStopWriters(ctx context.Context, operation Operation) error {
	if err := runtime.ReserveAdmission(ctx, operation); err != nil {
		return err
	}
	if err := runtime.sandboxes.StopAll(ctx, operation); err != nil {
		return fmt.Errorf("stop registered source Sandboxes: %w", err)
	}
	if err := runtime.sourceStack.StopFixed(ctx); err != nil {
		return fmt.Errorf("stop source fixed writers: %w", err)
	}
	return runtime.verifyWritersStopped(ctx, operation)
}

func (runtime *ProductionRuntime) CreateSnapshot(ctx context.Context, operation Operation) (handoff.Snapshot, error) {
	if err := runtime.verifyWritersStopped(ctx, operation); err != nil {
		return handoff.Snapshot{}, fmt.Errorf("snapshot requires a stopped source writer boundary: %w", err)
	}
	expected := filepath.Join(runtime.snapshotRoot, operation.TransactionID)
	if info, err := os.Lstat(expected); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return handoff.Snapshot{}, errors.New("existing handoff snapshot is not a real directory")
		}
		if err := runtime.snapshots.Verify(ctx, expected); err != nil {
			return handoff.Snapshot{}, fmt.Errorf("verify replayed handoff snapshot: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return handoff.Snapshot{}, fmt.Errorf("inspect handoff snapshot: %w", err)
	} else {
		created, err := runtime.snapshots.Create(ctx, operation.TransactionID)
		if err != nil {
			return handoff.Snapshot{}, err
		}
		if created != expected {
			return handoff.Snapshot{}, errors.New("snapshot backend published outside its transaction path")
		}
		if err := runtime.snapshots.Verify(ctx, expected); err != nil {
			return handoff.Snapshot{}, fmt.Errorf("verify new handoff snapshot: %w", err)
		}
	}
	digest, err := secureRegularSHA256(filepath.Join(expected, "manifest.json"), 1<<20)
	if err != nil {
		return handoff.Snapshot{}, fmt.Errorf("hash handoff snapshot manifest: %w", err)
	}
	return handoff.Snapshot{Path: expected, ManifestSHA256: digest}, nil
}

func (runtime *ProductionRuntime) FenceSource(ctx context.Context, operation Operation) error {
	if err := runtime.verifyWritersStopped(ctx, operation); err != nil {
		return err
	}
	disableErr := runtime.units.Disable(ctx, operation.Source.Unit)
	stopErr := runtime.units.Stop(ctx, operation.Source.Unit)
	if err := errors.Join(disableErr, stopErr); err != nil {
		return err
	}
	state, err := runtime.units.Inspect(ctx, operation.Source.Unit, operation.Source.UnitPath)
	if err != nil {
		return err
	}
	if state.ActiveState != "inactive" || state.MainPID != 0 || state.UnitFileState == "enabled" {
		return errors.New("source Manager remains active or boot-enabled after fencing")
	}
	return nil
}

func (runtime *ProductionRuntime) RestoreSourceBeforeFence(ctx context.Context, operation Operation, lease handoffstartup.JournalLease) error {
	if err := runtime.validateSourceGeneration(operation); err != nil {
		return err
	}
	if err := validateAbortStartupLease(lease, operation); err != nil {
		return err
	}
	// admission_reserved is already a side-effect boundary: StopAll or
	// StopFixed may have partially succeeded before the coordinator could
	// persist writers_stopped. Converge the source fixed stack from the first
	// phase that permits stopping it, then prove readiness before aborting.
	if operation.Phase == handoff.PhaseAdmissionReserved || operation.Phase == handoff.PhaseWritersStopped || operation.Phase == handoff.PhaseSnapshotReady {
		if err := runtime.sourceStack.VerifyCoreNetwork(ctx, operation.Source.CoreNetworkID); err != nil {
			return fmt.Errorf("prove source core network before fixed-stack recovery: %w", err)
		}
		if err := runtime.sourceStack.StartFixed(ctx, runtime.sourceManifest); err != nil {
			return fmt.Errorf("restore source fixed stack before fence: %w", err)
		}
		if err := runtime.sourceStack.Probe(ctx, runtime.sourceManifest); err != nil {
			return fmt.Errorf("prove restored source fixed stack: %w", err)
		}
	}
	state, err := runtime.units.Inspect(ctx, operation.Source.Unit, operation.Source.UnitPath)
	if err != nil {
		return err
	}
	if state.ActiveState != "active" {
		state, err = runtime.startAbortSource(ctx, operation, lease)
		if err != nil {
			return err
		}
	}
	if state.MainPID <= 1 || (operation.Source.UnitEnabled && state.UnitFileState != "enabled") {
		return errors.New("source Manager identity was not restored before fence")
	}
	return nil
}

func (runtime *ProductionRuntime) startAbortSource(ctx context.Context, operation Operation, lease handoffstartup.JournalLease) (UnitState, error) {
	issuer, err := runtime.abortIssuers.NewAbortSource(handoffstartup.AbortSourceIssuerOptions{
		Lease: lease, TransactionDirectory: operation.TransactionDirectory, Bindings: runtime.bindings,
	})
	if err != nil {
		return UnitState{}, fmt.Errorf("create abort source startup capability: %w", err)
	}
	defer issuer.Close()
	serveCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	served := make(chan struct {
		consumption handoffstartup.AbortSourceConsumption
		err         error
	}, 1)
	go func() {
		consumption, serveErr := issuer.Serve(serveCtx)
		served <- struct {
			consumption handoffstartup.AbortSourceConsumption
			err         error
		}{consumption: consumption, err: serveErr}
	}()
	fail := func(cause error) (UnitState, error) {
		cancel()
		result := <-served
		return UnitState{}, errors.Join(cause, result.err)
	}
	if err := runtime.units.Enable(ctx, operation.Source.Unit); err != nil {
		return fail(fmt.Errorf("restore source unit enablement: %w", err))
	}
	if err := runtime.units.StartWithLocator(ctx, operation.Source.Unit, operation.TransactionDirectory); err != nil {
		return fail(err)
	}
	state, err := runtime.waitUnitActive(ctx, operation.Source.Unit, operation.Source.UnitPath)
	if err != nil {
		return fail(err)
	}
	result := <-served
	if result.err != nil {
		return UnitState{}, fmt.Errorf("serve abort source startup capability: %w", result.err)
	}
	if result.consumption.PID != state.MainPID || result.consumption.TransactionID != operation.TransactionID ||
		result.consumption.Revision != operation.Revision || result.consumption.BindingSHA256 != operation.BindingSHA256 {
		return UnitState{}, errors.New("abort source capability consumption differs from systemd or the helper journal")
	}
	if err := validateAbortStartupLease(lease, operation); err != nil {
		return UnitState{}, fmt.Errorf("helper ownership changed after abort source startup: %w", err)
	}
	return state, nil
}

func validateAbortStartupLease(lease handoffstartup.JournalLease, operation Operation) error {
	journal, err := lease.Load()
	if err != nil {
		return fmt.Errorf("read helper abort startup lease: %w", err)
	}
	if journal.TransactionID != operation.TransactionID || journal.Revision != operation.Revision ||
		journal.BindingSHA256 != operation.BindingSHA256 || journal.Phase != operation.Phase ||
		journal.Status != handoff.StatusRunning || journal.DesiredOutcome != handoff.OutcomeForward ||
		!phaseAllowed(journal.Phase, []handoff.Phase{handoff.PhasePlanned, handoff.PhaseHelperArmed,
			handoff.PhaseAdmissionReserved, handoff.PhaseWritersStopped, handoff.PhaseSnapshotReady}) {
		return errors.New("helper abort startup lease differs from the exact pre-fence operation")
	}
	return nil
}

func (runtime *ProductionRuntime) ReleaseAdmission(ctx context.Context, operation Operation) error {
	if err := runtime.gate.Release(ctx, operation.TransactionID); err != nil {
		return fmt.Errorf("release source Platform admission: %w", err)
	}
	return nil
}

func (runtime *ProductionRuntime) validateSourceGeneration(operation Operation) error {
	if runtime.sourceManifest.ID() != operation.Release.PredecessorGeneration ||
		runtime.sourceManifest.SourceCommit != operation.Release.PredecessorGeneration {
		return errors.New("source runtime manifest differs from the handoff predecessor")
	}
	return nil
}

func (runtime *ProductionRuntime) verifyWritersStopped(ctx context.Context, operation Operation) error {
	if err := runtime.validateSourceGeneration(operation); err != nil {
		return err
	}
	if err := runtime.sandboxes.VerifyStopped(ctx, operation); err != nil {
		return err
	}
	return verifyFixedStackStopped(ctx, runtime.sourceStack, runtime.sourceManifest)
}

func verifyFixedStackStopped(ctx context.Context, stack GenerationStack, manifest release.Manifest) error {
	if err := stack.VerifyFixedWritersStopped(ctx, manifest); err != nil {
		return fmt.Errorf("closed-world fixed-writer proof: %w", err)
	}
	return nil
}

func (runtime *ProductionRuntime) waitUnitActive(ctx context.Context, unit, fragment string) (UnitState, error) {
	ticker := time.NewTicker(runtime.poll)
	defer ticker.Stop()
	for {
		state, err := runtime.units.Inspect(ctx, unit, fragment)
		if err == nil && state.ActiveState == "active" && state.MainPID > 1 {
			return state, nil
		}
		if err == nil && state.ActiveState == "failed" {
			return UnitState{}, errors.New("source participant unit failed during restoration")
		}
		select {
		case <-ctx.Done():
			return UnitState{}, ctx.Err()
		case <-ticker.C:
		}
	}
}

// RegisteredSandboxQuiescer stops exactly the containers recorded in the
// source registry after proving that no call/background process remains.
type RegisteredSandboxQuiescer struct {
	Registry interface{ Records() []sandbox.Record }
	Engine   interface {
		StopSandbox(context.Context, string) error
		InspectManagedSandbox(context.Context, string, string) (driver.ManagedSandboxState, error)
	}
}

func (quiescer RegisteredSandboxQuiescer) StopAll(ctx context.Context, operation Operation) error {
	if quiescer.Registry == nil || quiescer.Engine == nil {
		return errors.New("Sandbox quiescer dependencies are unavailable")
	}
	records := quiescer.Registry.Records()
	sort.Slice(records, func(left, right int) bool { return records[left].SandboxID < records[right].SandboxID })
	seen := map[string]struct{}{}
	for _, record := range records {
		if record.SandboxID == "" || record.SandboxHash == "" || record.ContainerName == "" || record.ActiveCalls != 0 || record.BackgroundProcesses != 0 {
			return errors.New("source Sandbox registry is not at an idle, bound state")
		}
		if _, duplicate := seen[record.SandboxID]; duplicate {
			return errors.New("source Sandbox registry contains duplicate identities")
		}
		seen[record.SandboxID] = struct{}{}
		state, err := quiescer.Engine.InspectManagedSandbox(ctx, record.ContainerName, record.SandboxHash)
		if err != nil {
			return fmt.Errorf("inspect Sandbox %s ownership: %w", record.SandboxID, err)
		}
		if state.Exists && !state.Owned {
			return fmt.Errorf("Sandbox %s is not owned by its registry binding", record.SandboxID)
		}
		if state.Exists && state.Running {
			if err := quiescer.Engine.StopSandbox(ctx, record.ContainerName); err != nil {
				return fmt.Errorf("stop Sandbox %s: %w", record.SandboxID, err)
			}
		}
	}
	return quiescer.VerifyStopped(ctx, operation)
}

func (quiescer RegisteredSandboxQuiescer) VerifyStopped(ctx context.Context, _ Operation) error {
	if quiescer.Registry == nil || quiescer.Engine == nil {
		return errors.New("Sandbox quiescer dependencies are unavailable")
	}
	for _, record := range quiescer.Registry.Records() {
		if record.ActiveCalls != 0 || record.BackgroundProcesses != 0 {
			return fmt.Errorf("Sandbox %s regained execution activity", record.SandboxID)
		}
		state, err := quiescer.Engine.InspectManagedSandbox(ctx, record.ContainerName, record.SandboxHash)
		if err != nil {
			return err
		}
		if state.Exists && (!state.Owned || state.Running) {
			return fmt.Errorf("Sandbox %s is not proven owned and stopped", record.SandboxID)
		}
	}
	return nil
}

func secureRegularSHA256(path string, maximum int64) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	metadata, ok := info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || !ok || metadata.Uid != uint32(os.Getuid()) ||
		metadata.Nlink != 1 || info.Mode().Perm()&0o077 != 0 || info.Size() < 0 || info.Size() > maximum {
		return "", errors.New("file is not an owner-only, single-link bounded regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return "", errors.New("file identity changed while opening")
	}
	hash := sha256.New()
	written, err := io.Copy(hash, io.LimitReader(file, maximum+1))
	if err != nil || written != info.Size() || written > maximum {
		return "", errors.New("file size changed while hashing")
	}
	after, err := file.Stat()
	if err != nil || !os.SameFile(info, after) || after.Size() != info.Size() {
		return "", errors.New("file identity changed while hashing")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
