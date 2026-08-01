//go:build linux

package handofflisteners

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofffd"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffowner"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

const (
	testSHA1 = "1111111111111111111111111111111111111111111111111111111111111111"
	testSHA2 = "2222222222222222222222222222222222222222222222222222222222222222"
	testOld  = "1111111111111111111111111111111111111111"
	testNew  = "2222222222222222222222222222222222222222"
)

type ownerState struct {
	mu    sync.Mutex
	owner PublicOwner
}

func (state *ownerState) get(context.Context, handoff.Journal, []handofffd.ListenerIdentity) (PublicOwner, error) {
	state.mu.Lock()
	defer state.mu.Unlock()
	return state.owner, nil
}

func (state *ownerState) set(owner PublicOwner) {
	state.mu.Lock()
	state.owner = owner
	state.mu.Unlock()
}

func newJournal(t *testing.T) handoff.Journal {
	t.Helper()
	base := t.TempDir()
	sourceRoot := filepath.Join(base, "ubitech-agent")
	targetRoot := filepath.Join(base, "agent-platform")
	for _, directory := range []string{sourceRoot, targetRoot} {
		if err := os.Mkdir(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Date(2026, 7, 31, 2, 0, 0, 0, time.UTC)
	journal, err := handoff.NewJournal(
		handoff.ReleaseBinding{
			PredecessorGeneration: testOld, BridgeGeneration: testNew,
			ManifestPath: filepath.Join(identity.SourceProfile().ManagerStateRoot(sourceRoot), "releases", testNew, "manifest.json"), ManifestSHA256: testSHA1,
			TargetManagerSHA256: testSHA2, TargetManagerVersion: testNew, TargetComposeSHA256: testSHA1,
		},
		handoff.SourceBinding{
			Namespace: "ubitech-agent-v1", Unit: "ubitech-agent-manager.service", UnitEnabled: true,
			UnitPath: filepath.Join(base, "systemd", "ubitech-agent-manager.service"), UnitSHA256: testSHA1,
			StableBinary: filepath.Join(base, "bin", "ubitech-manager"), StableSHA256: testSHA1,
			ConfigPath: filepath.Join(base, "config", "ubitech-agent", "manager.toml"), ConfigSHA256: testSHA1,
			ManifestPath: filepath.Join(identity.SourceProfile().ManagerStateRoot(sourceRoot), "releases", testOld, "manifest.json"), ManifestSHA256: testSHA1,
			ComposePath: filepath.Join(identity.SourceProfile().ManagerStateRoot(sourceRoot), "releases", testOld, "compose.yaml"), ComposeSHA256: testSHA1,
			DataRoot: sourceRoot, SocketPath: filepath.Join(sourceRoot, "manager", "control", "manager.sock"),
			ComposeProject: "ubitech-agent", CoreNetwork: "ubitech-agent_core", CoreNetworkID: strings.Repeat("c", 64), LabelPrefix: "org.ubitech.agent",
		},
		handoff.TargetBinding{
			Namespace: "agent-platform-v1", Unit: "agent-platform-manager.service",
			UnitPath: filepath.Join(base, "systemd", "agent-platform-manager.service"), StableBinary: filepath.Join(base, "bin", "agent-platform-manager"),
			ConfigPath: filepath.Join(base, "config", "agent-platform", "manager.toml"), ConfigSHA256: testSHA1, DataRoot: targetRoot,
			SocketPath: filepath.Join(base, "runtime", "agent-platform-manager", "manager.sock"), ComposeProject: "agent-platform",
			CoreNetwork: "agent-platform_core", LabelPrefix: "io.agent-platform",
		},
		handoff.Evidence{
			ManagerStateSHA256: testSHA1, SelfUpdateStateSHA256: testSHA1, SandboxRegistrySHA256: testSHA1,
			DockerInventorySHA256: testSHA1, DatabaseSchemaVersion: 27, DatabaseIntegrity: "ok",
			RuntimeIdentitySHA256: testSHA1, WorkspaceIdentitySHA256: testSHA1,
			BootID: "12345678-1234-1234-1234-123456789abc",
		}, now,
	)
	if err != nil {
		t.Fatal(err)
	}
	return journal
}

func phaseJournal(t *testing.T, journal handoff.Journal, wanted handoff.Phase) handoff.Journal {
	t.Helper()
	forward := []handoff.Phase{
		handoff.PhaseHelperArmed, handoff.PhaseAdmissionReserved, handoff.PhaseWritersStopped,
		handoff.PhaseSnapshotReady, handoff.PhaseSourceFenced, handoff.PhaseTargetStaged,
		handoff.PhaseDataRelocated, handoff.PhaseTargetStarted, handoff.PhaseTargetVerified,
		handoff.PhaseSourceRetired, handoff.PhaseTargetCommitPlanned,
	}
	at := journal.CreatedAt
	journal.Helper = &handoff.HelperEvidence{
		Unit:       "agent-platform-namespace-handoff-" + strings.TrimPrefix(journal.TransactionID, "handoff_")[:12] + ".service",
		UnitSHA256: testSHA1, Executable: filepath.Join(filepath.Dir(journal.Target.DataRoot), "helper"),
		SHA256: testSHA2, ArgvSHA256: testSHA1, ControlGroup: "/user.slice/helper",
	}
	for _, phase := range forward {
		at = at.Add(time.Second)
		if phase == handoff.PhaseSnapshotReady {
			journal.Snapshot = &handoff.Snapshot{Path: filepath.Join(filepath.Dir(journal.Source.DataRoot), "snapshot"), ManifestSHA256: testSHA1}
		}
		if phase == handoff.PhaseTargetVerified {
			startedAt := at.Add(-time.Second)
			journal.TargetAck = &handoff.TargetAck{
				ManagerVersion: testNew, ExecutableSHA256: testSHA2, SourceCommit: testNew,
				PID: 43, SocketPath: journal.Target.SocketPath, AutoUpdateCheckAt: startedAt,
				IssuedAt: startedAt, ProofSHA256: testSHA1,
			}
		}
		journal.History = append(journal.History, handoff.PhaseEvent{Phase: phase, At: at, Note: ""})
		journal.Phase = phase
		journal.Revision++
		journal.UpdatedAt = at
		if phase == wanted {
			if err := handoff.Validate(journal); err != nil {
				t.Fatalf("validate %s journal: %v", wanted, err)
			}
			return journal
		}
	}
	t.Fatalf("unsupported forward test phase %s", wanted)
	return handoff.Journal{}
}

func rollbackSourceStartedJournal(t *testing.T, journal handoff.Journal) handoff.Journal {
	t.Helper()
	journal = phaseJournal(t, journal, handoff.PhaseSourceFenced)
	journal.Status = handoff.StatusRecovering
	journal.DesiredOutcome = handoff.OutcomeRollback
	journal.Error = "test rollback"
	for _, phase := range []handoff.Phase{handoff.PhaseRollbackPlanned, handoff.PhaseTargetStopped, handoff.PhaseDataRestored, handoff.PhaseSourceStarted} {
		journal.UpdatedAt = journal.UpdatedAt.Add(time.Second)
		journal.History = append(journal.History, handoff.PhaseEvent{Phase: phase, At: journal.UpdatedAt})
		journal.Phase = phase
		journal.Revision++
	}
	if err := handoff.Validate(journal); err != nil {
		t.Fatal(err)
	}
	return journal
}

func tcpListener(t *testing.T) *net.TCPListener {
	t.Helper()
	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	return listener
}

func expectedResolver(expected []handofffd.ListenerIdentity) ExpectedResolver {
	return ExpectedResolverFunc(func(context.Context, handoff.Journal) ([]handofffd.ListenerIdentity, error) {
		return append([]handofffd.ListenerIdentity(nil), expected...), nil
	})
}

func TestSourceHelperTargetTransferKeepsSourceUntilAckAndUsesDistinctPaths(t *testing.T) {
	planned := newJournal(t)
	journal := phaseJournal(t, planned, handoff.PhaseSnapshotReady)
	directory := filepath.Join(t.TempDir(), journal.TransactionID)
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	source := tcpListener(t)
	expected := []handofffd.ListenerIdentity{{Name: "primary", Address: source.Addr().String()}}
	resolver := expectedResolver(expected)
	owners := &ownerState{owner: OwnerSource}
	authority := HelperAuthorityFunc(func(context.Context, handoff.Journal) error { return nil })
	helper, err := NewHelper(HelperOptions{TransactionDirectory: directory, TransactionID: journal.TransactionID, Expected: resolver, Probe: OwnershipProbeFunc(owners.get), Authority: authority})
	if err != nil {
		t.Fatal(err)
	}
	defer helper.Close()
	sender, err := NewSourceSender(SourceSenderOptions{TransactionDirectory: directory, TransactionID: journal.TransactionID, Expected: resolver, Probe: OwnershipProbeFunc(owners.get)})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	acquireLease := listenerStartupLease(t, journal)
	type acquiredResult struct {
		listeners []handofffd.NamedListener
		err       error
	}
	acquired := make(chan acquiredResult, 1)
	go func() {
		state, acquireErr := helper.EnsureMaintenance(ctx, journal, acquireLease, handoffowner.ListenerState{})
		acquired <- acquiredResult{listeners: state.Listeners, err: acquireErr}
	}()
	if err := sender.SendCurrent(ctx, planned, []handofffd.NamedListener{{Name: "primary", Listener: source}}); err != nil {
		t.Fatal(err)
	}
	result := <-acquired
	if result.err != nil {
		t.Fatal(result.err)
	}
	// The sender retains a valid original descriptor, while the helper accepts
	// through a disposable duplicate and serves its neutral maintenance page.
	if _, err := handofffd.Describe([]handofffd.NamedListener{{Name: "primary", Listener: source}}); err != nil {
		t.Fatalf("source descriptor was closed before helper handoff: %v", err)
	}
	response, err := (&http.Client{Timeout: time.Second}).Get("http://" + source.Addr().String() + "/anything")
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusServiceUnavailable || !strings.Contains(string(body), "Maintenance is in progress") || strings.Contains(strings.ToLower(string(body)), "ubitech") {
		t.Fatalf("helper maintenance response = %d %q", response.StatusCode, body)
	}

	// Keep the exact transaction/binding used by the live helper and advance it.
	targetJournal := phaseJournal(t, journalFromPlanned(journal), handoff.PhaseSourceRetired)
	targetLease := listenerStartupLease(t, targetJournal)
	participant, err := OpenParticipantReceiver(ParticipantOptions{TransactionDirectory: directory, TransactionID: journal.TransactionID, Role: ParticipantTarget, Expected: resolver})
	if err != nil {
		t.Fatal(err)
	}
	defer participant.Close()
	received := make(chan acquiredResult, 1)
	go func() {
		var listeners []handofffd.NamedListener
		receiveErr := participant.ReceiveAndAdopt(ctx, targetJournal, func(values []handofffd.NamedListener) error {
			listeners = values
			owners.set(OwnerTarget)
			return nil
		})
		received <- acquiredResult{listeners: listeners, err: receiveErr}
	}()
	if err := helper.CommitToTarget(ctx, targetJournal, targetLease, result.listeners); err != nil {
		t.Fatal(err)
	}
	target := <-received
	if target.err != nil || len(target.listeners) != 1 {
		t.Fatalf("target receive = %#v, %v", target.listeners, target.err)
	}
	defer closeListeners(target.listeners)
	if _, err := socketPath(directory, journal.TransactionID, handofffd.SourceToHelperSocketBasename); err != nil {
		t.Fatal(err)
	}
	for _, base := range []string{handofffd.SourceToHelperSocketBasename, handofffd.HelperToTargetSocketBasename, handofffd.HelperToSourceSocketBasename} {
		if base == "" {
			t.Fatal("empty role socket basename")
		}
	}
}

// journalFromPlanned strips phase evidence while preserving the immutable
// transaction and binding, allowing tests to advance the same transaction.
func journalFromPlanned(journal handoff.Journal) handoff.Journal {
	journal.Revision = 1
	journal.Status = handoff.StatusRunning
	journal.DesiredOutcome = handoff.OutcomeForward
	journal.Phase = handoff.PhasePlanned
	journal.Helper = nil
	journal.Snapshot = nil
	journal.TargetAck = nil
	journal.AbortCleanup = nil
	journal.History = journal.History[:1]
	journal.Error = ""
	journal.UpdatedAt = journal.CreatedAt
	journal.CompletedAt = nil
	return journal
}

// listenerStartupLease builds a real opaque lease around the exact journal
// used by a focused listener test. The test replaces the pristine planned
// bytes before opening Helper so production code still has no fake-lease or
// authority-only bypass.
func listenerStartupLease(t *testing.T, journal handoff.Journal) handoff.StartupLease {
	_, lease := openListenerStartupLease(t, journal)
	return lease
}

func openListenerStartupLease(t *testing.T, journal handoff.Journal) (*handoff.Helper, handoff.StartupLease) {
	t.Helper()
	base := t.TempDir()
	stateHome := filepath.Join(base, "state")
	if err := os.Mkdir(stateHome, 0o700); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(stateHome, "agent-platform", "handoff")
	store, err := handoff.Open(root, journal.Source.DataRoot, journal.Target.DataRoot)
	if err != nil {
		t.Fatal(err)
	}
	planned := journalFromPlanned(journal)
	if _, err := store.Create(planned); err != nil {
		_ = store.Close()
		t.Fatal(err)
	}
	encoded, err := json.Marshal(journal)
	if err != nil {
		_ = store.Close()
		t.Fatal(err)
	}
	journalPath := filepath.Join(root, journal.TransactionID, "journal.json")
	if err := os.WriteFile(journalPath, append(encoded, '\n'), 0o600); err != nil {
		_ = store.Close()
		t.Fatal(err)
	}
	helper, current, err := store.OpenHelper(journal.TransactionID)
	if err != nil {
		_ = store.Close()
		t.Fatal(err)
	}
	if current.Revision != journal.Revision || current.BindingSHA256 != journal.BindingSHA256 || current.Phase != journal.Phase {
		_ = helper.Close()
		_ = store.Close()
		t.Fatalf("test helper opened a different journal: got revision=%d phase=%s", current.Revision, current.Phase)
	}
	t.Cleanup(func() {
		_ = helper.Close()
		_ = store.Close()
	})
	return helper, helper.StartupLease()
}

func TestPostFenceReplayRebindsMaintenanceBeforeContinuing(t *testing.T) {
	for _, phase := range []handoff.Phase{
		handoff.PhaseSourceFenced, handoff.PhaseTargetStaged, handoff.PhaseDataRelocated,
		handoff.PhaseTargetStarted, handoff.PhaseTargetVerified, handoff.PhaseSourceRetired,
		handoff.PhaseTargetCommitPlanned,
	} {
		t.Run(string(phase), func(t *testing.T) {
			journal := phaseJournal(t, newJournal(t), phase)
			lease := listenerStartupLease(t, journal)
			directory := filepath.Join(t.TempDir(), journal.TransactionID)
			if err := os.Mkdir(directory, 0o700); err != nil {
				t.Fatal(err)
			}
			seed := tcpListener(t)
			expected := []handofffd.ListenerIdentity{{Name: "primary", Address: seed.Addr().String()}}
			_ = seed.Close()
			helper, err := NewHelper(HelperOptions{
				TransactionDirectory: directory, TransactionID: journal.TransactionID,
				Expected: expectedResolver(expected),
				Probe: OwnershipProbeFunc(func(context.Context, handoff.Journal, []handofffd.ListenerIdentity) (PublicOwner, error) {
					return OwnerNone, nil
				}),
				Authority: HelperAuthorityFunc(func(context.Context, handoff.Journal) error { return nil }),
			})
			if err != nil {
				t.Fatal(err)
			}
			defer helper.Close()
			state, err := helper.EnsureMaintenance(context.Background(), journal, lease, handoffowner.ListenerState{})
			if err != nil {
				t.Fatal(err)
			}
			if state.Owner != handoffowner.ListenerOwnerHelper || len(state.Listeners) != 1 {
				t.Fatalf("maintenance custody = %+v", state)
			}
			response, err := (&http.Client{Timeout: time.Second}).Get("http://" + expected[0].Address + "/")
			if err != nil {
				t.Fatal(err)
			}
			_ = response.Body.Close()
			if response.StatusCode != http.StatusServiceUnavailable {
				t.Fatalf("maintenance status = %d", response.StatusCode)
			}
		})
	}
}

func TestTargetCommitReplayRebindsThenTransfersBeforeCommit(t *testing.T) {
	journal := phaseJournal(t, newJournal(t), handoff.PhaseTargetCommitPlanned)
	lease := listenerStartupLease(t, journal)
	directory := filepath.Join(t.TempDir(), journal.TransactionID)
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	seed := tcpListener(t)
	expected := []handofffd.ListenerIdentity{{Name: "primary", Address: seed.Addr().String()}}
	_ = seed.Close()
	owners := &ownerState{owner: OwnerNone}
	helper, err := NewHelper(HelperOptions{
		TransactionDirectory: directory, TransactionID: journal.TransactionID,
		Expected: expectedResolver(expected), Probe: OwnershipProbeFunc(owners.get),
		Authority: HelperAuthorityFunc(func(context.Context, handoff.Journal) error { return nil }),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer helper.Close()
	state, err := helper.EnsureMaintenance(context.Background(), journal, lease, handoffowner.ListenerState{})
	if err != nil || state.Owner != handoffowner.ListenerOwnerHelper {
		t.Fatalf("rebind target-commit maintenance = %+v, %v", state, err)
	}
	participant, err := OpenParticipantReceiver(ParticipantOptions{
		TransactionDirectory: directory, TransactionID: journal.TransactionID,
		Role: ParticipantTarget, Expected: expectedResolver(expected),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer participant.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	received := make(chan error, 1)
	var adopted []handofffd.NamedListener
	go func() {
		received <- participant.ReceiveAndAdopt(ctx, journal, func(values []handofffd.NamedListener) error {
			adopted = values
			owners.set(OwnerTarget)
			return nil
		})
	}()
	if err := helper.CommitToTarget(ctx, journal, lease, state.Listeners); err != nil {
		t.Fatal(err)
	}
	if err := <-received; err != nil {
		t.Fatal(err)
	}
	defer closeListeners(adopted)
	observed, err := helper.EnsureMaintenance(ctx, journal, lease, handoffowner.ListenerState{Owner: handoffowner.ListenerOwnerTarget})
	if err != nil || observed.Owner != handoffowner.ListenerOwnerTarget || len(observed.Listeners) != 0 {
		t.Fatalf("target ownership replay = %+v, %v", observed, err)
	}
}

func TestMaintenanceOwnerMustMatchReplayPhase(t *testing.T) {
	journal := phaseJournal(t, newJournal(t), handoff.PhaseTargetStarted)
	lease := listenerStartupLease(t, journal)
	directory := filepath.Join(t.TempDir(), journal.TransactionID)
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	listener := tcpListener(t)
	helper, err := NewHelper(HelperOptions{
		TransactionDirectory: directory, TransactionID: journal.TransactionID,
		Expected: expectedResolver([]handofffd.ListenerIdentity{{Name: "primary", Address: listener.Addr().String()}}),
		Probe: OwnershipProbeFunc(func(context.Context, handoff.Journal, []handofffd.ListenerIdentity) (PublicOwner, error) {
			return OwnerTarget, nil
		}),
		Authority: HelperAuthorityFunc(func(context.Context, handoff.Journal) error { return nil }),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer helper.Close()
	if _, err := helper.EnsureMaintenance(context.Background(), journal, lease, handoffowner.ListenerState{}); err == nil || !strings.Contains(err.Error(), "incompatible") {
		t.Fatalf("early target owner was accepted: %v", err)
	}
}

func TestNilReplayRequiresExactOwnerOrRebindsUnderDurableLock(t *testing.T) {
	journal := phaseJournal(t, newJournal(t), handoff.PhaseSourceRetired)
	lease := listenerStartupLease(t, journal)
	directory := filepath.Join(t.TempDir(), journal.TransactionID)
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	seed := tcpListener(t)
	expected := []handofffd.ListenerIdentity{{Name: "primary", Address: seed.Addr().String()}}
	_ = seed.Close()
	owners := &ownerState{owner: OwnerNone}
	rebinds := 0
	rebinder := RebinderFunc(func(ctx context.Context, identities []handofffd.ListenerIdentity) ([]handofffd.NamedListener, error) {
		rebinds++
		listeners, err := (TCPRebinder{}).Rebind(ctx, identities)
		if err == nil {
			owners.set(OwnerHelper)
		}
		return listeners, err
	})
	helper, err := NewHelper(HelperOptions{
		TransactionDirectory: directory, TransactionID: journal.TransactionID, Expected: expectedResolver(expected),
		Probe: OwnershipProbeFunc(owners.get), Authority: HelperAuthorityFunc(func(context.Context, handoff.Journal) error { return nil }), Rebinder: rebinder,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer helper.Close()
	participant, err := OpenParticipantReceiver(ParticipantOptions{TransactionDirectory: directory, TransactionID: journal.TransactionID, Role: ParticipantTarget, Expected: expectedResolver(expected)})
	if err != nil {
		t.Fatal(err)
	}
	defer participant.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	received := make(chan error, 1)
	go func() {
		listeners, receiveErr := participant.Receive(ctx, journal)
		_ = closeListeners(listeners)
		received <- receiveErr
	}()
	if err := helper.CommitToTarget(ctx, journal, lease, nil); err != nil {
		t.Fatal(err)
	}
	if err := <-received; err != nil {
		t.Fatal(err)
	}
	if rebinds != 1 {
		t.Fatalf("rebind count = %d, want 1", rebinds)
	}
	owners.set(OwnerTarget)
	if err := helper.CommitToTarget(ctx, journal, lease, nil); err != nil {
		t.Fatalf("already-transferred nil replay failed: %v", err)
	}
	if rebinds != 1 {
		t.Fatal("already-transferred replay unexpectedly rebound listeners")
	}
}

func TestRejectedParticipantAdoptionRestoresHelperMaintenance(t *testing.T) {
	journal := phaseJournal(t, newJournal(t), handoff.PhaseSourceRetired)
	lease := listenerStartupLease(t, journal)
	directory := filepath.Join(t.TempDir(), journal.TransactionID)
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	seed := tcpListener(t)
	expected := []handofffd.ListenerIdentity{{Name: "primary", Address: seed.Addr().String()}}
	_ = seed.Close()
	helper, err := NewHelper(HelperOptions{
		TransactionDirectory: directory,
		TransactionID:        journal.TransactionID,
		Expected:             expectedResolver(expected),
		Probe: OwnershipProbeFunc(func(context.Context, handoff.Journal, []handofffd.ListenerIdentity) (PublicOwner, error) {
			return OwnerNone, nil
		}),
		Authority: HelperAuthorityFunc(func(context.Context, handoff.Journal) error { return nil }),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer helper.Close()
	participant, err := OpenParticipantReceiver(ParticipantOptions{
		TransactionDirectory: directory,
		TransactionID:        journal.TransactionID,
		Role:                 ParticipantTarget,
		Expected:             expectedResolver(expected),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer participant.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	received := make(chan error, 1)
	go func() {
		received <- participant.ReceiveAndAdopt(ctx, journal, func([]handofffd.NamedListener) error {
			return errors.New("gateway rejected listeners")
		})
	}()
	if err := helper.CommitToTarget(ctx, journal, lease, nil); err == nil {
		t.Fatal("helper reported success after participant rejected adoption")
	}
	if err := <-received; err == nil || !strings.Contains(err.Error(), "gateway rejected listeners") {
		t.Fatalf("participant adoption failure = %v", err)
	}
	response, err := (&http.Client{Timeout: time.Second}).Get("http://" + expected[0].Address + "/")
	if err != nil {
		t.Fatalf("helper maintenance did not resume: %v", err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("resumed helper maintenance status = %d", response.StatusCode)
	}
}

func TestNilReplayRejectsUnknownOwnership(t *testing.T) {
	journal := phaseJournal(t, newJournal(t), handoff.PhaseSourceRetired)
	lease := listenerStartupLease(t, journal)
	directory := filepath.Join(t.TempDir(), journal.TransactionID)
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	listener := tcpListener(t)
	expected := []handofffd.ListenerIdentity{{Name: "primary", Address: listener.Addr().String()}}
	helper, err := NewHelper(HelperOptions{
		TransactionDirectory: directory, TransactionID: journal.TransactionID, Expected: expectedResolver(expected),
		Probe: OwnershipProbeFunc(func(context.Context, handoff.Journal, []handofffd.ListenerIdentity) (PublicOwner, error) {
			return OwnerUnknown, nil
		}),
		Authority: HelperAuthorityFunc(func(context.Context, handoff.Journal) error { return nil }),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer helper.Close()
	if err := helper.CommitToTarget(context.Background(), journal, lease, nil); err == nil || !strings.Contains(err.Error(), "unknown") {
		t.Fatalf("unknown-owner replay result: %v", err)
	}
}

func TestTCPRebinderClosesPartialSetOnAddressConflict(t *testing.T) {
	occupied := tcpListener(t)
	free := tcpListener(t)
	freeAddress := free.Addr().String()
	_ = free.Close()
	expected := []handofffd.ListenerIdentity{
		{Name: "lan", Address: freeAddress},
		{Name: "primary", Address: occupied.Addr().String()},
	}
	if _, err := (TCPRebinder{}).Rebind(context.Background(), expected); err == nil {
		t.Fatal("address conflict unexpectedly rebound a partial listener set")
	}
	listener, err := net.Listen("tcp", freeAddress)
	if err != nil {
		t.Fatalf("partial LAN listener leaked after primary conflict: %v", err)
	}
	_ = listener.Close()
}

func TestDurableBindLockRejectsConcurrentRecoveryAndUnsafeReplacement(t *testing.T) {
	directory := t.TempDir()
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	first, err := acquireDurableBindLock(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if _, err := acquireDurableBindLock(directory); err == nil {
		t.Fatal("concurrent durable bind lock was accepted")
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, bindLockBasename)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("elsewhere", path); err != nil {
		t.Fatal(err)
	}
	if _, err := acquireDurableBindLock(directory); err == nil {
		t.Fatal("symlinked durable bind lock was accepted")
	}
}

func TestRestoreReplayAcceptsExactSourceOwner(t *testing.T) {
	journal := rollbackSourceStartedJournal(t, newJournal(t))
	lease := listenerStartupLease(t, journal)
	directory := filepath.Join(t.TempDir(), journal.TransactionID)
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	listener := tcpListener(t)
	expected := []handofffd.ListenerIdentity{{Name: "primary", Address: listener.Addr().String()}}
	helper, err := NewHelper(HelperOptions{
		TransactionDirectory: directory, TransactionID: journal.TransactionID, Expected: expectedResolver(expected),
		Probe: OwnershipProbeFunc(func(context.Context, handoff.Journal, []handofffd.ListenerIdentity) (PublicOwner, error) {
			return OwnerSource, nil
		}),
		Authority: HelperAuthorityFunc(func(context.Context, handoff.Journal) error { return nil }),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer helper.Close()
	if err := helper.RestoreToSource(context.Background(), journal, lease, nil); err != nil {
		t.Fatal(err)
	}
}

func TestAbortBeforeFenceTransfersHeldListenersToRestrictedSource(t *testing.T) {
	journal := phaseJournal(t, newJournal(t), handoff.PhaseSnapshotReady)
	lease := listenerStartupLease(t, journal)
	directory := filepath.Join(t.TempDir(), journal.TransactionID)
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	listener := tcpListener(t)
	expected := []handofffd.ListenerIdentity{{Name: "primary", Address: listener.Addr().String()}}
	owners := &ownerState{owner: OwnerHelper}
	helper, err := NewHelper(HelperOptions{
		TransactionDirectory: directory, TransactionID: journal.TransactionID, Expected: expectedResolver(expected),
		Probe: OwnershipProbeFunc(owners.get), Authority: HelperAuthorityFunc(func(context.Context, handoff.Journal) error { return nil }),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer helper.Close()
	receiver, err := OpenParticipantReceiver(ParticipantOptions{
		TransactionDirectory: directory, TransactionID: journal.TransactionID,
		Role: ParticipantSource, Expected: expectedResolver(expected),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer receiver.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	received := make(chan error, 1)
	go func() {
		received <- receiver.ReceiveAndAdopt(ctx, journal, func([]handofffd.NamedListener) error {
			owners.set(OwnerSource)
			return nil
		})
	}()
	if err := helper.RestoreToSource(ctx, journal, lease, []handofffd.NamedListener{{Name: "primary", Listener: listener}}); err != nil {
		t.Fatal(err)
	}
	if err := <-received; err != nil {
		t.Fatal(err)
	}
}

func TestHelperAuthorityFailurePreventsRebind(t *testing.T) {
	journal := phaseJournal(t, newJournal(t), handoff.PhaseSourceRetired)
	lease := listenerStartupLease(t, journal)
	directory := filepath.Join(t.TempDir(), journal.TransactionID)
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	listener := tcpListener(t)
	expected := []handofffd.ListenerIdentity{{Name: "primary", Address: listener.Addr().String()}}
	_ = listener.Close()
	rebound := false
	helper, err := NewHelper(HelperOptions{
		TransactionDirectory: directory, TransactionID: journal.TransactionID, Expected: expectedResolver(expected),
		Probe: OwnershipProbeFunc(func(context.Context, handoff.Journal, []handofffd.ListenerIdentity) (PublicOwner, error) {
			return OwnerNone, nil
		}),
		Authority: HelperAuthorityFunc(func(context.Context, handoff.Journal) error { return errors.New("lease lost") }),
		Rebinder: RebinderFunc(func(context.Context, []handofffd.ListenerIdentity) ([]handofffd.NamedListener, error) {
			rebound = true
			return nil, nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer helper.Close()
	if err := helper.CommitToTarget(context.Background(), journal, lease, nil); err == nil || rebound {
		t.Fatalf("lost helper lease did not fail before rebind: err=%v rebound=%v", err, rebound)
	}
}

func TestNoOpAuthorityCannotReplaceStartupLease(t *testing.T) {
	journal := phaseJournal(t, newJournal(t), handoff.PhaseSourceRetired)
	directory := filepath.Join(t.TempDir(), journal.TransactionID)
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	probeCalled := false
	helper, err := NewHelper(HelperOptions{
		TransactionDirectory: directory,
		TransactionID:        journal.TransactionID,
		Expected:             expectedResolver([]handofffd.ListenerIdentity{{Name: "primary", Address: "127.0.0.1:18765"}}),
		Probe: OwnershipProbeFunc(func(context.Context, handoff.Journal, []handofffd.ListenerIdentity) (PublicOwner, error) {
			probeCalled = true
			return OwnerNone, nil
		}),
		Authority: HelperAuthorityFunc(func(context.Context, handoff.Journal) error { return nil }),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer helper.Close()
	if err := helper.CommitToTarget(context.Background(), journal, handoff.StartupLease{}, nil); err == nil || !strings.Contains(err.Error(), "startup lease") {
		t.Fatalf("zero startup lease result = %v", err)
	}
	if probeCalled {
		t.Fatal("no-op authority allowed listener probing without the coordinator lease")
	}
}

func TestListenerBoundaryRejectsDifferentAndExpiredStartupLease(t *testing.T) {
	planned := newJournal(t)
	wrongJournal := phaseJournal(t, planned, handoff.PhaseSnapshotReady)
	journal := phaseJournal(t, journalFromPlanned(planned), handoff.PhaseSourceRetired)
	_, wrongLease := openListenerStartupLease(t, wrongJournal)
	directory := filepath.Join(t.TempDir(), journal.TransactionID)
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	probeCalled := false
	helper, err := NewHelper(HelperOptions{
		TransactionDirectory: directory, TransactionID: journal.TransactionID,
		Expected: expectedResolver([]handofffd.ListenerIdentity{{Name: "primary", Address: "127.0.0.1:18765"}}),
		Probe: OwnershipProbeFunc(func(context.Context, handoff.Journal, []handofffd.ListenerIdentity) (PublicOwner, error) {
			probeCalled = true
			return OwnerNone, nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer helper.Close()
	if err := helper.CommitToTarget(context.Background(), journal, wrongLease, nil); err == nil || !strings.Contains(err.Error(), "differs") {
		t.Fatalf("different journal lease result = %v", err)
	}
	if probeCalled {
		t.Fatal("different journal lease reached listener ownership probe")
	}

	leaseHelper, lease := openListenerStartupLease(t, journal)
	if err := leaseHelper.Close(); err != nil {
		t.Fatal(err)
	}
	if err := helper.CommitToTarget(context.Background(), journal, lease, nil); err == nil || !strings.Contains(err.Error(), "closed") {
		t.Fatalf("expired startup lease result = %v", err)
	}
	if probeCalled {
		t.Fatal("expired journal lease reached listener ownership probe")
	}
}

func TestLeaseLossAfterRebindClosesNewDescriptors(t *testing.T) {
	journal := phaseJournal(t, newJournal(t), handoff.PhaseSourceRetired)
	leaseHelper, lease := openListenerStartupLease(t, journal)
	directory := filepath.Join(t.TempDir(), journal.TransactionID)
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	seed := tcpListener(t)
	address := seed.Addr().String()
	_ = seed.Close()
	expected := []handofffd.ListenerIdentity{{Name: "primary", Address: address}}
	helper, err := NewHelper(HelperOptions{
		TransactionDirectory: directory, TransactionID: journal.TransactionID,
		Expected: expectedResolver(expected),
		Probe: OwnershipProbeFunc(func(context.Context, handoff.Journal, []handofffd.ListenerIdentity) (PublicOwner, error) {
			return OwnerNone, nil
		}),
		Rebinder: RebinderFunc(func(ctx context.Context, identities []handofffd.ListenerIdentity) ([]handofffd.NamedListener, error) {
			listeners, err := (TCPRebinder{}).Rebind(ctx, identities)
			if err != nil {
				return nil, err
			}
			if err := leaseHelper.Close(); err != nil {
				_ = closeListeners(listeners)
				return nil, err
			}
			return listeners, nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer helper.Close()
	if err := helper.CommitToTarget(context.Background(), journal, lease, nil); err == nil || !strings.Contains(err.Error(), "closed") {
		t.Fatalf("lease loss after rebind result = %v", err)
	}
	reopened, err := net.Listen("tcp", address)
	if err != nil {
		t.Fatalf("listener from rejected rebind leaked: %v", err)
	}
	_ = reopened.Close()
}
