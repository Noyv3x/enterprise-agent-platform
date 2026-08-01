//go:build linux

package handoffhelper

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffstartup"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/operation"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

type runtimeGateFake struct {
	reserved int
	released int
}

func (gate *runtimeGateFake) Reserve(context.Context, string) (operation.Reservation, error) {
	gate.reserved++
	return operation.Reservation{Reserved: true}, nil
}
func (gate *runtimeGateFake) Release(context.Context, string) error { gate.released++; return nil }
func (*runtimeGateFake) Health(context.Context) error               { return nil }

type generationStackFake struct {
	running             bool
	starts              int
	stops               int
	probes              int
	writerProbeFailures int
	stopErr             error
	startErr            error
	probeErr            error
	networkErr          error
	networkProofs       []string
	networkRemovals     [][2]string
	name                string
	events              *[]string
}

func (stack *generationStackFake) VerifyCoreNetwork(_ context.Context, expectedID string) error {
	stack.networkProofs = append(stack.networkProofs, expectedID)
	return stack.networkErr
}

func (stack *generationStackFake) VerifyFixedWritersStopped(context.Context, release.Manifest) error {
	if stack.writerProbeFailures > 0 {
		stack.writerProbeFailures--
		return errors.New("fixed-writer probe failed")
	}
	if stack.running {
		return errors.New("fixed writer remains running")
	}
	return nil
}

func (stack *generationStackFake) RemoveTransactionCoreNetwork(_ context.Context, transactionID, bindingSHA256 string) error {
	if stack.events != nil {
		*stack.events = append(*stack.events, "network:"+stack.name)
	}
	stack.networkRemovals = append(stack.networkRemovals, [2]string{transactionID, bindingSHA256})
	return stack.networkErr
}

func (stack *generationStackFake) StopFixed(context.Context) error {
	if stack.events != nil {
		*stack.events = append(*stack.events, "stop:"+stack.name)
	}
	stack.running = false
	stack.stops++
	return stack.stopErr
}
func (stack *generationStackFake) StartFixed(context.Context, release.Manifest) error {
	if stack.events != nil {
		*stack.events = append(*stack.events, "stack:"+stack.name)
	}
	stack.running = true
	stack.starts++
	return stack.startErr
}
func (stack *generationStackFake) Probe(context.Context, release.Manifest) error {
	stack.probes++
	if stack.probeErr != nil {
		return stack.probeErr
	}
	if !stack.running {
		return os.ErrNotExist
	}
	return nil
}

type snapshotBackendFake struct {
	root    string
	creates int
}

func (backend *snapshotBackendFake) Create(_ context.Context, id string) (string, error) {
	backend.creates++
	path := filepath.Join(backend.root, id)
	if err := os.MkdirAll(path, 0o700); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(path, "manifest.json"), []byte(`{"schema_version":1}`), 0o600); err != nil {
		return "", err
	}
	return path, nil
}
func (*snapshotBackendFake) Verify(context.Context, string) error { return nil }

type sandboxQuiescerFake struct {
	stopped bool
	stopErr error
}

func (sandbox *sandboxQuiescerFake) StopAll(context.Context, Operation) error {
	sandbox.stopped = true
	return sandbox.stopErr
}
func (sandbox *sandboxQuiescerFake) VerifyStopped(context.Context, Operation) error {
	if !sandbox.stopped {
		return os.ErrInvalid
	}
	return nil
}

type abortIssuerFake struct {
	consumption handoffstartup.AbortSourceConsumption
}

func (issuer *abortIssuerFake) Serve(context.Context) (handoffstartup.AbortSourceConsumption, error) {
	return issuer.consumption, nil
}
func (*abortIssuerFake) Close() error { return nil }

type abortIssuerFactoryFake struct{}

func (abortIssuerFactoryFake) NewAbortSource(options handoffstartup.AbortSourceIssuerOptions) (AbortSourceStartupIssuer, error) {
	journal, err := options.Lease.Load()
	if err != nil {
		return nil, err
	}
	return &abortIssuerFake{consumption: handoffstartup.AbortSourceConsumption{
		PID: 111, TransactionID: journal.TransactionID, Revision: journal.Revision, BindingSHA256: journal.BindingSHA256,
	}}, nil
}

type unitControllerFake struct {
	states        map[string]UnitState
	locatorStarts int
	events        *[]string
}

func (units *unitControllerFake) Inspect(_ context.Context, unit, fragment string) (UnitState, error) {
	state := units.states[unit]
	if state.FragmentPath == "" {
		state.FragmentPath = fragment
	}
	return state, nil
}
func (units *unitControllerFake) Enable(_ context.Context, unit string) error {
	state := units.states[unit]
	state.UnitFileState = "enabled"
	units.states[unit] = state
	return nil
}
func (units *unitControllerFake) Disable(_ context.Context, unit string) error {
	state := units.states[unit]
	state.UnitFileState = "disabled"
	units.states[unit] = state
	return nil
}
func (units *unitControllerFake) Stop(_ context.Context, unit string) error {
	state := units.states[unit]
	state.ActiveState, state.MainPID = "inactive", 0
	units.states[unit] = state
	return nil
}
func (units *unitControllerFake) StartWithLocator(_ context.Context, unit, _ string) error {
	if units.events != nil {
		*units.events = append(*units.events, "unit:"+unit)
	}
	units.locatorStarts++
	state := units.states[unit]
	state.LoadState, state.ActiveState, state.MainPID = "loaded", "active", 111
	units.states[unit] = state
	return nil
}

func TestProductionRuntimeStopsSnapshotsFencesAndReplaysPreFenceRestore(t *testing.T) {
	root := t.TempDir()
	snapshotRoot := filepath.Join(root, "backups")
	if err := os.Mkdir(snapshotRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	gate := &runtimeGateFake{}
	stack := &generationStackFake{running: true}
	sandboxes := &sandboxQuiescerFake{}
	units := &unitControllerFake{states: map[string]UnitState{
		"source.service": {LoadState: "loaded", ActiveState: "active", UnitFileState: "enabled", FragmentPath: filepath.Join(root, "source.service"), MainPID: 99},
	}}
	snapshots := &snapshotBackendFake{root: snapshotRoot}
	manifest := release.Manifest{SourceCommit: testPredecessor}
	source, target := identity.SourceProfile(), identity.TargetProfile()
	sourceRoot, targetRoot := filepath.Join(root, source.DataDirectory), filepath.Join(root, target.DataDirectory)
	sourceSocket, _ := source.ControlSocketPath(sourceRoot, "")
	targetSocket, _ := target.ControlSocketPath(targetRoot, filepath.Join(root, "run"))
	bindings := handoffstartup.Bindings{
		Source: handoffstartup.RuntimePaths{
			StableBinary: source.ManagerInstallPath(filepath.Join(root, "bin")), ConfigPath: source.DefaultConfigPath(filepath.Join(root, "config")),
			DataRoot: sourceRoot, StateRoot: source.ManagerStateRoot(sourceRoot), SocketPath: sourceSocket,
		},
		Target: handoffstartup.RuntimePaths{
			StableBinary: target.ManagerInstallPath(filepath.Join(root, "target-bin")), ConfigPath: target.DefaultConfigPath(filepath.Join(root, "target-config")),
			DataRoot: targetRoot, StateRoot: target.ManagerStateRoot(targetRoot), SocketPath: targetSocket,
		},
	}
	runtime, err := NewProductionRuntime(ProductionRuntimeOptions{
		Gate: gate, SourceStack: stack, SourceManifest: manifest, Bindings: bindings, Snapshots: snapshots,
		SnapshotRoot: snapshotRoot, Sandboxes: sandboxes, Units: units, AbortIssuers: abortIssuerFactoryFake{},
	})
	if err != nil {
		t.Fatal(err)
	}
	operation := Operation{
		TransactionID:        "handoff_0123456789abcdef0123456789abcdef",
		TransactionDirectory: filepath.Join(root, "handoff_0123456789abcdef0123456789abcdef"),
		Revision:             7, BindingSHA256: testProofSHA, Status: handoff.StatusRunning, DesiredOutcome: handoff.OutcomeForward,
		Release: handoff.ReleaseBinding{PredecessorGeneration: testPredecessor},
		Source: handoff.SourceBinding{Unit: "source.service", UnitPath: filepath.Join(root, "source.service"), UnitEnabled: true,
			CoreNetworkID: "abcdefabcdef"},
		Phase: handoff.PhaseAdmissionReserved,
	}
	if err := runtime.DrainAndStopWriters(context.Background(), operation); err != nil {
		t.Fatal(err)
	}
	operation.Phase = handoff.PhaseWritersStopped
	first, err := runtime.CreateSnapshot(context.Background(), operation)
	if err != nil {
		t.Fatal(err)
	}
	second, err := runtime.CreateSnapshot(context.Background(), operation)
	if err != nil {
		t.Fatal(err)
	}
	if first != second || snapshots.creates != 1 {
		t.Fatalf("snapshot replay = %#v / %#v, creates=%d", first, second, snapshots.creates)
	}
	operation.Phase = handoff.PhaseSnapshotReady
	if err := runtime.FenceSource(context.Background(), operation); err != nil {
		t.Fatal(err)
	}
	lease := staticJournalLease{journal: handoff.Journal{
		TransactionID: operation.TransactionID, Revision: operation.Revision, BindingSHA256: operation.BindingSHA256,
		Phase: operation.Phase, Status: handoff.StatusRunning, DesiredOutcome: handoff.OutcomeForward,
	}}
	stack.networkErr = errors.New("bound source network changed")
	if err := runtime.RestoreSourceBeforeFence(context.Background(), operation, lease); err == nil {
		t.Fatal("pre-fence restore accepted a changed source network")
	}
	if stack.starts != 0 || units.locatorStarts != 0 {
		t.Fatalf("source restore crossed a failed network proof: starts=%d locator=%d", stack.starts, units.locatorStarts)
	}
	stack.networkErr = nil
	if err := runtime.RestoreSourceBeforeFence(context.Background(), operation, lease); err != nil {
		t.Fatal(err)
	}
	if stack.starts != 1 || stack.probes != 1 || units.locatorStarts != 1 ||
		len(stack.networkProofs) != 2 || stack.networkProofs[0] != operation.Source.CoreNetworkID ||
		stack.networkProofs[1] != operation.Source.CoreNetworkID {
		t.Fatalf("pre-fence restore stack starts=%d probes=%d locator=%d", stack.starts, stack.probes, units.locatorStarts)
	}
	if err := runtime.ReleaseAdmission(context.Background(), operation); err != nil {
		t.Fatal(err)
	}
	if gate.reserved != 1 || gate.released != 1 {
		t.Fatalf("reservation calls reserve=%d release=%d", gate.reserved, gate.released)
	}
}

func TestPreFenceAbortRestoresSourceAfterEveryPartialStopFailure(t *testing.T) {
	for _, test := range []struct {
		name      string
		configure func(*generationStackFake, *sandboxQuiescerFake)
	}{
		{"sandbox stop", func(_ *generationStackFake, sandboxes *sandboxQuiescerFake) {
			sandboxes.stopErr = errors.New("partial Sandbox stop")
		}},
		{"fixed stack stop", func(stack *generationStackFake, _ *sandboxQuiescerFake) {
			stack.stopErr = errors.New("partial fixed stop")
		}},
		{"final stopped probe", func(stack *generationStackFake, _ *sandboxQuiescerFake) {
			stack.writerProbeFailures = 1
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			snapshotRoot := filepath.Join(root, "backups")
			if err := os.Mkdir(snapshotRoot, 0o700); err != nil {
				t.Fatal(err)
			}
			source, target := identity.SourceProfile(), identity.TargetProfile()
			sourceRoot, targetRoot := filepath.Join(root, source.DataDirectory), filepath.Join(root, target.DataDirectory)
			sourceSocket, _ := source.ControlSocketPath(sourceRoot, "")
			targetSocket, _ := target.ControlSocketPath(targetRoot, filepath.Join(root, "run"))
			bindings := handoffstartup.Bindings{
				Source: handoffstartup.RuntimePaths{StableBinary: source.ManagerInstallPath(filepath.Join(root, "bin")), ConfigPath: source.DefaultConfigPath(filepath.Join(root, "config")), DataRoot: sourceRoot, StateRoot: source.ManagerStateRoot(sourceRoot), SocketPath: sourceSocket},
				Target: handoffstartup.RuntimePaths{StableBinary: target.ManagerInstallPath(filepath.Join(root, "target-bin")), ConfigPath: target.DefaultConfigPath(filepath.Join(root, "target-config")), DataRoot: targetRoot, StateRoot: target.ManagerStateRoot(targetRoot), SocketPath: targetSocket},
			}
			stack := &generationStackFake{running: true}
			sandboxes := &sandboxQuiescerFake{}
			test.configure(stack, sandboxes)
			units := &unitControllerFake{states: map[string]UnitState{
				"source.service": {LoadState: "loaded", ActiveState: "active", UnitFileState: "enabled", FragmentPath: filepath.Join(root, "source.service"), MainPID: 99},
			}}
			runtime, err := NewProductionRuntime(ProductionRuntimeOptions{
				Gate: &runtimeGateFake{}, SourceStack: stack, SourceManifest: release.Manifest{SourceCommit: testPredecessor},
				Bindings: bindings, Snapshots: &snapshotBackendFake{root: snapshotRoot}, SnapshotRoot: snapshotRoot,
				Sandboxes: sandboxes, Units: units, AbortIssuers: abortIssuerFactoryFake{},
			})
			if err != nil {
				t.Fatal(err)
			}
			operation := Operation{
				TransactionID: "handoff_0123456789abcdef0123456789abcdef", TransactionDirectory: filepath.Join(root, "handoff_0123456789abcdef0123456789abcdef"),
				Revision: 7, BindingSHA256: testProofSHA, Status: handoff.StatusRunning, DesiredOutcome: handoff.OutcomeForward,
				Release: handoff.ReleaseBinding{PredecessorGeneration: testPredecessor},
				Source:  handoff.SourceBinding{Unit: "source.service", UnitPath: filepath.Join(root, "source.service"), UnitEnabled: true},
				Phase:   handoff.PhaseAdmissionReserved,
			}
			if err := runtime.DrainAndStopWriters(context.Background(), operation); err == nil {
				t.Fatal("injected partial stop failure was not returned")
			}
			lease := staticJournalLease{journal: handoff.Journal{
				TransactionID: operation.TransactionID, Revision: operation.Revision, BindingSHA256: operation.BindingSHA256,
				Phase: operation.Phase, Status: operation.Status, DesiredOutcome: operation.DesiredOutcome,
			}}
			if err := runtime.RestoreSourceBeforeFence(context.Background(), operation, lease); err != nil {
				t.Fatalf("restore partial stop: %v", err)
			}
			if !stack.running || stack.starts != 1 || stack.probes != 1 {
				t.Fatalf("source fixed stack not restored: running=%v starts=%d probes=%d", stack.running, stack.starts, stack.probes)
			}
		})
	}
}
