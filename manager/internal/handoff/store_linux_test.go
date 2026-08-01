//go:build linux

package handoff

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

func TestOpenOrCreateDefaultStateHomeCreatesOnlyAccountDefault(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	if err := os.Mkdir(home, 0o700); err != nil {
		t.Fatal(err)
	}
	stateHome := filepath.Join(home, ".local", "state")
	fd, err := openOrCreateDefaultStateHome(stateHome, home)
	if err != nil {
		t.Fatal(err)
	}
	if err := syscall.Close(fd); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(home, ".local"), stateHome} {
		info, err := os.Lstat(path)
		if err != nil {
			t.Fatal(err)
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o700 {
			t.Fatalf("created state path %q has mode %v", path, info.Mode())
		}
	}
	if _, err := openOrCreateDefaultStateHome(filepath.Join(home, "elsewhere"), home); err == nil || !strings.Contains(err.Error(), "explicit") {
		t.Fatalf("non-default missing state home was accepted: %v", err)
	}
}

func TestOpenOrCreateDefaultStateHomeRejectsSymlinkAndUnsafeParents(t *testing.T) {
	t.Run("symlink", func(t *testing.T) {
		root := t.TempDir()
		home := filepath.Join(root, "home")
		external := filepath.Join(root, "external")
		if err := os.Mkdir(home, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(external, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(external, filepath.Join(home, ".local")); err != nil {
			t.Fatal(err)
		}
		if _, err := openOrCreateDefaultStateHome(filepath.Join(home, ".local", "state"), home); err == nil {
			t.Fatal("symlinked .local was accepted")
		}
		if _, err := os.Lstat(filepath.Join(external, "state")); !os.IsNotExist(err) {
			t.Fatalf("symlink target was modified: %v", err)
		}
	})
	t.Run("writable parent", func(t *testing.T) {
		home := filepath.Join(t.TempDir(), "home")
		if err := os.MkdirAll(filepath.Join(home, ".local"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(home, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(filepath.Join(home, ".local"), 0o770); err != nil {
			t.Fatal(err)
		}
		if _, err := openOrCreateDefaultStateHome(filepath.Join(home, ".local", "state"), home); err == nil {
			t.Fatal("group-writable .local was accepted")
		}
	})
	t.Run("wrong type", func(t *testing.T) {
		home := filepath.Join(t.TempDir(), "home")
		if err := os.Mkdir(home, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(home, ".local"), []byte("not a directory"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := openOrCreateDefaultStateHome(filepath.Join(home, ".local", "state"), home); err == nil {
			t.Fatal("non-directory .local was accepted")
		}
	})
}

func TestOpenOrCreateStateHomeRejectsMissingExplicitPath(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "explicit-state")
	if _, err := openOrCreateStateHome(missing); err == nil || !strings.Contains(err.Error(), "explicit") {
		t.Fatalf("missing explicit state home was accepted: %v", err)
	}
	if _, err := os.Lstat(missing); !os.IsNotExist(err) {
		t.Fatalf("missing explicit state home was created: %v", err)
	}
}

const (
	testPredecessor = "1111111111111111111111111111111111111111"
	testBridge      = "2222222222222222222222222222222222222222"
	testSHA         = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testSHA2        = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

type testFixture struct {
	base       string
	root       string
	sourceRoot string
	targetRoot string
	store      *Store
	journal    Journal
	now        time.Time
}

func newTestFixture(t *testing.T) testFixture {
	t.Helper()
	base := t.TempDir()
	stateHome := filepath.Join(base, "state")
	sourceRoot := filepath.Join(base, "data", "ubitech-agent")
	targetRoot := filepath.Join(base, "data", "agent-platform")
	for _, path := range []string{stateHome, sourceRoot} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	root := filepath.Join(stateHome, "agent-platform", "handoff")
	store, err := Open(root, sourceRoot, targetRoot)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	now := time.Date(2026, 7, 31, 1, 2, 3, 0, time.UTC)
	release := ReleaseBinding{
		PredecessorGeneration: testPredecessor,
		BridgeGeneration:      testBridge,
		ManifestPath:          filepath.Join(identity.SourceProfile().ManagerStateRoot(sourceRoot), "releases", testBridge, "manifest.json"),
		ManifestSHA256:        testSHA,
		TargetManagerSHA256:   testSHA2,
		TargetManagerVersion:  testBridge,
		TargetComposeSHA256:   testSHA,
	}
	source := SourceBinding{
		Namespace:      "ubitech-agent-v1",
		Unit:           "ubitech-agent-manager.service",
		UnitEnabled:    true,
		UnitPath:       filepath.Join(base, "config", "systemd", "user", "ubitech-agent-manager.service"),
		UnitSHA256:     testSHA,
		StableBinary:   filepath.Join(base, "bin", "ubitech-manager"),
		StableSHA256:   testSHA,
		ConfigPath:     filepath.Join(base, "config", "ubitech-agent", "manager.toml"),
		ConfigSHA256:   testSHA,
		ManifestPath:   filepath.Join(identity.SourceProfile().ManagerStateRoot(sourceRoot), "releases", testPredecessor, "manifest.json"),
		ManifestSHA256: testSHA,
		ComposePath:    filepath.Join(identity.SourceProfile().ManagerStateRoot(sourceRoot), "releases", testPredecessor, "compose.yaml"),
		ComposeSHA256:  testSHA,
		DataRoot:       sourceRoot,
		SocketPath:     filepath.Join(sourceRoot, "manager", "control", "manager.sock"),
		ComposeProject: "ubitech-agent",
		CoreNetwork:    "ubitech-agent_core",
		CoreNetworkID:  strings.Repeat("c", 64),
		LabelPrefix:    "org.ubitech.agent",
	}
	target := TargetBinding{
		Namespace:      "agent-platform-v1",
		Unit:           "agent-platform-manager.service",
		UnitPath:       filepath.Join(base, "config", "systemd", "user", "agent-platform-manager.service"),
		StableBinary:   filepath.Join(base, "bin", "agent-platform-manager"),
		ConfigPath:     filepath.Join(base, "config", "agent-platform", "manager.toml"),
		ConfigSHA256:   testSHA,
		DataRoot:       targetRoot,
		SocketPath:     filepath.Join(base, "runtime", "agent-platform-manager", "manager.sock"),
		ComposeProject: "agent-platform",
		CoreNetwork:    "agent-platform_core",
		LabelPrefix:    "io.agent-platform",
	}
	evidence := Evidence{
		ManagerStateSHA256:      testSHA,
		SelfUpdateStateSHA256:   testSHA,
		SandboxRegistrySHA256:   testSHA,
		DockerInventorySHA256:   testSHA,
		DatabaseSchemaVersion:   27,
		DatabaseIntegrity:       "ok",
		RuntimeIdentitySHA256:   testSHA,
		WorkspaceIdentitySHA256: testSHA,
		BootID:                  "12345678-1234-1234-1234-123456789abc",
	}
	journal, err := NewJournal(release, source, target, evidence, now)
	if err != nil {
		t.Fatalf("NewJournal: %v", err)
	}
	return testFixture{base: base, root: root, sourceRoot: sourceRoot, targetRoot: targetRoot, store: store, journal: journal, now: now}
}

func TestStartupLeaseIsReadOnlyAndExpiresWithHelper(t *testing.T) {
	fixture := newTestFixture(t)
	created, err := fixture.store.Create(fixture.journal)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	helper, current, err := fixture.store.OpenHelper(created.TransactionID)
	if err != nil {
		t.Fatalf("OpenHelper: %v", err)
	}
	lease := helper.StartupLease()
	loaded, err := lease.Load()
	if err != nil {
		t.Fatalf("StartupLease.Load: %v", err)
	}
	if loaded.Revision != current.Revision || loaded.BindingSHA256 != current.BindingSHA256 {
		t.Fatalf("startup lease loaded a different journal: %#v", loaded)
	}
	if err := helper.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := lease.Load(); err == nil || !strings.Contains(err.Error(), "closed") {
		t.Fatalf("closed helper startup lease remained usable: %v", err)
	}
	if _, err := (StartupLease{}).Load(); err == nil {
		t.Fatal("zero startup lease was accepted")
	}
}

func TestJournalAllowsArbitrarySourceConfigButKeepsTargetCanonical(t *testing.T) {
	fixture := newTestFixture(t)
	journal := fixture.journal
	journal.Source.ConfigPath = filepath.Join(fixture.base, "arbitrary", "p1-installed.toml")
	digest, err := ComputeBindingSHA256(journal)
	if err != nil {
		t.Fatal(err)
	}
	journal.BindingSHA256 = digest
	if err := Validate(journal); err != nil {
		t.Fatalf("arbitrary source config was rejected: %v", err)
	}
	journal.Target.ConfigPath = filepath.Join(fixture.base, "arbitrary", "target.toml")
	digest, err = ComputeBindingSHA256(journal)
	if err != nil {
		t.Fatal(err)
	}
	journal.BindingSHA256 = digest
	if err := Validate(journal); err == nil || !strings.Contains(err.Error(), "target paths") {
		t.Fatalf("arbitrary target config was accepted: %v", err)
	}
}

func TestCreatePlannedRetainsGlobalLockAcrossBuilderAndAtomicCreate(t *testing.T) {
	fixture := newTestFixture(t)
	entered := make(chan struct{})
	release := make(chan struct{})
	created := make(chan error, 1)
	go func() {
		_, existing, err := fixture.store.CreatePlanned(func() (Journal, error) {
			close(entered)
			<-release
			return fixture.journal, nil
		})
		if err == nil && existing {
			err = errors.New("planned create unexpectedly reused a transaction")
		}
		created <- err
	}()
	<-entered

	if _, _, err := fixture.store.DiscoverNonTerminal(); !errors.Is(err, ErrBusy) {
		t.Fatalf("observer crossed the retained planned-create lock: %v", err)
	}
	close(release)
	if err := <-created; err != nil {
		t.Fatalf("CreatePlanned: %v", err)
	}
	journal, found, err := fixture.store.DiscoverNonTerminal()
	if err != nil || !found || journal.TransactionID != fixture.journal.TransactionID {
		t.Fatalf("DiscoverNonTerminal after create = journal=%q found=%v err=%v", journal.TransactionID, found, err)
	}
}

func TestCreatePlannedDoesNotInvokeBuilderWhenTransactionExists(t *testing.T) {
	fixture := newTestFixture(t)
	if _, err := fixture.store.Create(fixture.journal); err != nil {
		t.Fatal(err)
	}
	called := false
	journal, existing, err := fixture.store.CreatePlanned(func() (Journal, error) {
		called = true
		return Journal{}, errors.New("must not run")
	})
	if err != nil || !existing || called || journal.TransactionID != fixture.journal.TransactionID {
		t.Fatalf("existing transaction result = journal=%q existing=%v called=%v err=%v", journal.TransactionID, existing, called, err)
	}
}

func TestOpenExistingLearnsRootsOnlyFromLockedJournals(t *testing.T) {
	fixture := newTestFixture(t)
	if _, err := fixture.store.Create(fixture.journal); err != nil {
		t.Fatal(err)
	}
	if err := fixture.store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenExisting(fixture.root)
	if err != nil {
		t.Fatalf("OpenExisting: %v", err)
	}
	defer reopened.Close()
	if reopened.sourceDataRoot != fixture.sourceRoot || reopened.targetDataRoot != fixture.targetRoot {
		t.Fatalf("existing roots = %q/%q", reopened.sourceDataRoot, reopened.targetDataRoot)
	}
	journal, found, err := reopened.DiscoverNonTerminal()
	if err != nil || !found || journal.TransactionID != fixture.journal.TransactionID {
		t.Fatalf("reopened journal = %q found=%v err=%v", journal.TransactionID, found, err)
	}
}

func TestOpenExistingCreatesNoMissingLockOrJournalState(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "state", "agent-platform", "handoff")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(base, "state"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenExisting(root); err == nil {
		t.Fatal("empty existing root was accepted")
	}
	if _, err := os.Lstat(filepath.Join(root, globalLockName)); !os.IsNotExist(err) {
		t.Fatalf("OpenExisting created a missing global lock: %v", err)
	}
}

func TestOpenExistingReportsInitializedRootWithoutJournals(t *testing.T) {
	fixture := newTestFixture(t)
	root := fixture.store.Root()
	if err := fixture.store.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenExisting(root); !errors.Is(err, ErrNoJournals) {
		t.Fatalf("OpenExisting empty initialized root = %v, want ErrNoJournals", err)
	}
}

func helperEvidence(f testFixture) *HelperEvidence {
	suffix := strings.TrimPrefix(f.journal.TransactionID, "handoff_")[:12]
	return &HelperEvidence{
		Unit:         "agent-platform-namespace-handoff-" + suffix + ".service",
		UnitSHA256:   testSHA,
		Executable:   filepath.Join(f.base, "releases", testBridge, "agent-platform-manager"),
		SHA256:       testSHA2,
		ArgvSHA256:   testSHA,
		ControlGroup: "/user.slice/user-1000.slice/app.slice/handoff.service",
	}
}

func mutatePhase(t *testing.T, helper *Helper, current Journal, at time.Time, phase Phase) Journal {
	t.Helper()
	next, err := helper.Mutate(current.Revision, at, func(journal *Journal) error {
		journal.Phase = phase
		return nil
	})
	if err != nil {
		t.Fatalf("advance %s -> %s: %v", current.Phase, phase, err)
	}
	return next
}

func armHelper(t *testing.T, helper *Helper, f testFixture, current Journal, at time.Time) Journal {
	t.Helper()
	next, err := helper.Mutate(current.Revision, at, func(journal *Journal) error {
		journal.Helper = helperEvidence(f)
		return nil
	})
	if err != nil {
		t.Fatalf("persist helper evidence: %v", err)
	}
	return mutatePhase(t, helper, next, at.Add(time.Second), PhaseHelperArmed)
}

func advanceToSourceFenced(t *testing.T, helper *Helper, f testFixture, current Journal) Journal {
	t.Helper()
	at := f.now.Add(time.Minute)
	current = armHelper(t, helper, f, current, at)
	current = mutatePhase(t, helper, current, at.Add(2*time.Second), PhaseAdmissionReserved)
	current = mutatePhase(t, helper, current, at.Add(3*time.Second), PhaseWritersStopped)
	var err error
	current, err = helper.Mutate(current.Revision, at.Add(4*time.Second), func(journal *Journal) error {
		journal.Snapshot = &Snapshot{Path: filepath.Join(f.base, "snapshots", f.journal.TransactionID), ManifestSHA256: testSHA}
		return nil
	})
	if err != nil {
		t.Fatalf("persist snapshot: %v", err)
	}
	current = mutatePhase(t, helper, current, at.Add(5*time.Second), PhaseSnapshotReady)
	return mutatePhase(t, helper, current, at.Add(6*time.Second), PhaseSourceFenced)
}

func TestStoreCreateLoadAndTerminalReplay(t *testing.T) {
	f := newTestFixture(t)
	created, err := f.store.Create(f.journal)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	discovered, found, err := f.store.DiscoverNonTerminal()
	if err != nil || !found || discovered.TransactionID != created.TransactionID {
		t.Fatalf("DiscoverNonTerminal = (%q, %v, %v)", discovered.TransactionID, found, err)
	}
	helper, current, err := f.store.OpenHelper(created.TransactionID)
	if err != nil {
		t.Fatalf("OpenHelper: %v", err)
	}
	current = advanceToSourceFenced(t, helper, f, current)
	at := f.now.Add(2 * time.Minute)
	current = mutatePhase(t, helper, current, at, PhaseTargetStaged)
	current = mutatePhase(t, helper, current, at.Add(time.Second), PhaseDataRelocated)
	current = mutatePhase(t, helper, current, at.Add(2*time.Second), PhaseTargetStarted)
	startedAt, _ := firstPhaseTime(current.History, PhaseTargetStarted)
	current, err = helper.Mutate(current.Revision, at.Add(3*time.Second), func(journal *Journal) error {
		journal.TargetAck = &TargetAck{
			ManagerVersion: testBridge, ExecutableSHA256: testSHA2, SourceCommit: testBridge,
			PID: 2345, SocketPath: journal.Target.SocketPath, AutoUpdateCheckAt: startedAt.Add(250 * time.Millisecond),
			IssuedAt: startedAt.Add(500 * time.Millisecond), ProofSHA256: testSHA,
		}
		return nil
	})
	if err != nil {
		t.Fatalf("persist target ack: %v", err)
	}
	current = mutatePhase(t, helper, current, at.Add(4*time.Second), PhaseTargetVerified)
	current = mutatePhase(t, helper, current, at.Add(5*time.Second), PhaseSourceRetired)
	current = mutatePhase(t, helper, current, at.Add(6*time.Second), PhaseTargetCommitPlanned)
	terminalRevision := current.Revision
	current, err = helper.Mutate(current.Revision, at.Add(7*time.Second), func(journal *Journal) error {
		// Keep the Platform's exact legal RFC 3339 spelling. Reformatting this
		// through time.Time would turn .500000Z into .5Z and invalidate the
		// cross-runtime receipt digest.
		committedAt := at.Add(6500*time.Millisecond).UTC().Format("2006-01-02T15:04:05") + ".500000Z"
		receipt := TargetPlatformCommit{
			SchemaVersion: 1, OperationID: journal.TransactionID,
			TargetGeneration: journal.Release.BridgeGeneration, BindingSHA256: journal.BindingSHA256,
			DatabaseSchemaVersion: journal.Evidence.DatabaseSchemaVersion, CommittedAt: committedAt,
		}
		receipt.ReceiptSHA256, _ = ComputeTargetPlatformCommitSHA256(receipt)
		journal.TargetPlatformCommit = &receipt
		journal.Phase = PhaseCommitted
		journal.Status = StatusCommitted
		return nil
	})
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	if !current.Terminal() || current.Revision != terminalRevision+1 || current.CompletedAt == nil {
		t.Fatalf("invalid committed journal: %+v", current)
	}
	replayed, err := helper.Mutate(terminalRevision, at.Add(8*time.Second), func(journal *Journal) error {
		journal.Phase = PhaseCommitted
		journal.Status = StatusCommitted
		return nil
	})
	if err != nil || replayed.Revision != current.Revision {
		t.Fatalf("terminal replay = (revision %d, %v)", replayed.Revision, err)
	}
	if _, err := helper.Mutate(current.Revision, at.Add(9*time.Second), func(journal *Journal) error {
		journal.Error = "late mutation"
		return nil
	}); !errors.Is(err, ErrTerminal) {
		t.Fatalf("terminal mutation error = %v, want ErrTerminal", err)
	}
	if err := helper.Close(); err != nil {
		t.Fatal(err)
	}
	loaded, err := f.store.Load(created.TransactionID)
	if err != nil || loaded.Status != StatusCommitted {
		t.Fatalf("Load terminal = (%s, %v)", loaded.Status, err)
	}
	if _, found, err := f.store.DiscoverNonTerminal(); err != nil || found {
		t.Fatalf("Discover after commit = (found %v, %v)", found, err)
	}
}

func TestObservationLeaseRetainsRootIdentityAndExcludesWriters(t *testing.T) {
	f := newTestFixture(t)
	created, err := f.store.Create(f.journal)
	if err != nil {
		t.Fatal(err)
	}
	lease, journals, err := f.store.OpenObservation()
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	if len(journals) != 1 || journals[0].TransactionID != created.TransactionID {
		t.Fatalf("observation journals = %#v", journals)
	}
	if _, _, err := f.store.OpenHelper(created.TransactionID); !errors.Is(err, ErrBusy) {
		t.Fatalf("writer acquired while observation held: %v", err)
	}

	original := f.root + ".original"
	if err := os.Rename(f.root, original); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(f.root, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := lease.Read(); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("path-swapped observation root error = %v", err)
	}
}

func TestObservationLeaseUsesCanonicalStrictJournalDecoder(t *testing.T) {
	f := newTestFixture(t)
	created, err := f.store.Create(f.journal)
	if err != nil {
		t.Fatal(err)
	}
	journalPath := filepath.Join(f.root, created.TransactionID, journalName)
	raw, err := os.ReadFile(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	raw = []byte(strings.Replace(string(raw), `"schema_version": 1,`, `"schema_version": 1, "schema_version": 1,`, 1))
	if err := os.WriteFile(journalPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.store.OpenObservation(); err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("strict observation decoder error = %v", err)
	}
}

func TestMutateCASConcurrencyAndWriteOnce(t *testing.T) {
	f := newTestFixture(t)
	created, err := f.store.Create(f.journal)
	if err != nil {
		t.Fatal(err)
	}
	helper, current, err := f.store.OpenHelper(created.TransactionID)
	if err != nil {
		t.Fatal(err)
	}
	defer helper.Close()
	expected := current.Revision
	var wait sync.WaitGroup
	errorsSeen := make(chan error, 2)
	for range 2 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, mutationErr := helper.Mutate(expected, f.now.Add(time.Minute), func(journal *Journal) error {
				journal.Helper = helperEvidence(f)
				return nil
			})
			errorsSeen <- mutationErr
		}()
	}
	wait.Wait()
	close(errorsSeen)
	successes, conflicts := 0, 0
	for mutationErr := range errorsSeen {
		switch {
		case mutationErr == nil:
			successes++
		case errors.Is(mutationErr, ErrRevisionConflict):
			conflicts++
		default:
			t.Fatalf("unexpected concurrent mutation error: %v", mutationErr)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("concurrent CAS successes=%d conflicts=%d", successes, conflicts)
	}
	current, err = helper.Load()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := helper.Mutate(current.Revision, f.now.Add(2*time.Minute), func(journal *Journal) error {
		journal.Helper.ArgvSHA256 = testSHA2
		return nil
	}); err == nil || !strings.Contains(err.Error(), "write-once") {
		t.Fatalf("helper evidence overwrite error = %v", err)
	}
}

func TestIllegalTransitionsAckTimingAndAbortEvidence(t *testing.T) {
	t.Run("illegal phase jump", func(t *testing.T) {
		f := newTestFixture(t)
		created, err := f.store.Create(f.journal)
		if err != nil {
			t.Fatal(err)
		}
		helper, current, err := f.store.OpenHelper(created.TransactionID)
		if err != nil {
			t.Fatal(err)
		}
		defer helper.Close()
		if _, err := helper.Mutate(current.Revision, f.now.Add(time.Minute), func(journal *Journal) error {
			journal.Phase = PhaseAdmissionReserved
			return nil
		}); err == nil || !strings.Contains(err.Error(), "illegal") {
			t.Fatalf("illegal phase jump error = %v", err)
		}
	})

	t.Run("ack predates target start", func(t *testing.T) {
		f := newTestFixture(t)
		created, err := f.store.Create(f.journal)
		if err != nil {
			t.Fatal(err)
		}
		helper, current, err := f.store.OpenHelper(created.TransactionID)
		if err != nil {
			t.Fatal(err)
		}
		defer helper.Close()
		current = advanceToSourceFenced(t, helper, f, current)
		at := f.now.Add(2 * time.Minute)
		current = mutatePhase(t, helper, current, at, PhaseTargetStaged)
		current = mutatePhase(t, helper, current, at.Add(time.Second), PhaseDataRelocated)
		current = mutatePhase(t, helper, current, at.Add(2*time.Second), PhaseTargetStarted)
		_, err = helper.Mutate(current.Revision, at.Add(3*time.Second), func(journal *Journal) error {
			journal.TargetAck = &TargetAck{
				ManagerVersion: testBridge, ExecutableSHA256: testSHA2, SourceCommit: testBridge, PID: 42,
				SocketPath: journal.Target.SocketPath, AutoUpdateCheckAt: f.now, IssuedAt: f.now, ProofSHA256: testSHA,
			}
			return nil
		})
		if err == nil || !strings.Contains(err.Error(), "predates") {
			t.Fatalf("early target ack error = %v", err)
		}
	})

	t.Run("abort requires complete cleanup", func(t *testing.T) {
		f := newTestFixture(t)
		created, err := f.store.Create(f.journal)
		if err != nil {
			t.Fatal(err)
		}
		helper, current, err := f.store.OpenHelper(created.TransactionID)
		if err != nil {
			t.Fatal(err)
		}
		defer helper.Close()
		if _, err := helper.Mutate(current.Revision, f.now.Add(time.Minute), func(journal *Journal) error {
			journal.Status = StatusAborted
			journal.DesiredOutcome = OutcomeRollback
			journal.Phase = PhaseAborted
			return nil
		}); err == nil || !strings.Contains(err.Error(), "cleanup") {
			t.Fatalf("incomplete abort error = %v", err)
		}
		current, err = helper.Mutate(current.Revision, f.now.Add(2*time.Minute), func(journal *Journal) error {
			journal.AbortCleanup = &AbortCleanup{true, true, true, true, true}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		current, err = helper.Mutate(current.Revision, f.now.Add(3*time.Minute), func(journal *Journal) error {
			journal.Status = StatusAborted
			journal.DesiredOutcome = OutcomeRollback
			journal.Phase = PhaseAborted
			return nil
		})
		if err != nil || current.Status != StatusAborted || current.CompletedAt == nil {
			t.Fatalf("complete abort = (%s, %v)", current.Status, err)
		}
	})
}

func TestErrorAfterSourceFenceCreatesRecoverableRollback(t *testing.T) {
	f := newTestFixture(t)
	created, err := f.store.Create(f.journal)
	if err != nil {
		t.Fatal(err)
	}
	helper, current, err := f.store.OpenHelper(created.TransactionID)
	if err != nil {
		t.Fatal(err)
	}
	defer helper.Close()
	current = advanceToSourceFenced(t, helper, f, current)
	current, err = helper.Mutate(current.Revision, f.now.Add(3*time.Minute), func(journal *Journal) error {
		journal.Error = "target staging failed"
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if current.Status != StatusRecovering || current.DesiredOutcome != OutcomeRollback || current.Phase != PhaseRollbackPlanned {
		t.Fatalf("post-fence error did not establish rollback intent: %+v", current)
	}
	current = mutatePhase(t, helper, current, f.now.Add(4*time.Minute), PhaseTargetStopped)
	current = mutatePhase(t, helper, current, f.now.Add(5*time.Minute), PhaseDataRestored)
	current = mutatePhase(t, helper, current, f.now.Add(6*time.Minute), PhaseSourceStarted)
	current, err = helper.Mutate(current.Revision, f.now.Add(7*time.Minute), func(journal *Journal) error {
		journal.Phase = PhaseRolledBack
		journal.Status = StatusRolledBack
		return nil
	})
	if err != nil || current.Status != StatusRolledBack {
		t.Fatalf("rolled back = (%s, %v)", current.Status, err)
	}
}

func TestStoreRejectsUnsafePathsAndJournalObjects(t *testing.T) {
	t.Run("root symlink", func(t *testing.T) {
		base := t.TempDir()
		state := filepath.Join(base, "state")
		source := filepath.Join(base, "data", "ubitech-agent")
		target := filepath.Join(base, "data", "agent-platform")
		if err := os.MkdirAll(filepath.Join(state, "real"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(source, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink("real", filepath.Join(state, "agent-platform")); err != nil {
			t.Fatal(err)
		}
		if _, err := Open(filepath.Join(state, "agent-platform", "handoff"), source, target); !errors.Is(err, ErrUnsafePath) {
			t.Fatalf("Open symlink root error = %v", err)
		}
	})

	t.Run("root containment", func(t *testing.T) {
		base := t.TempDir()
		state := filepath.Join(base, "state")
		if err := os.MkdirAll(filepath.Join(state, "ubitech-agent"), 0o700); err != nil {
			t.Fatal(err)
		}
		root := filepath.Join(state, "ubitech-agent", "agent-platform", "handoff")
		if _, err := Open(root, filepath.Join(state, "ubitech-agent"), filepath.Join(base, "target")); !errors.Is(err, ErrUnsafePath) {
			t.Fatalf("Open contained root error = %v", err)
		}
	})

	for _, test := range []struct {
		name   string
		tamper func(t *testing.T, path string)
	}{
		{"symlink", func(t *testing.T, path string) {
			t.Helper()
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			target := path + ".target"
			if err := os.WriteFile(target, data, 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, path); err != nil {
				t.Fatal(err)
			}
		}},
		{"hardlink", func(t *testing.T, path string) {
			t.Helper()
			if err := os.Link(path, path+".hardlink"); err != nil {
				t.Fatal(err)
			}
		}},
		{"wide mode", func(t *testing.T, path string) {
			t.Helper()
			if err := os.Chmod(path, 0o644); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run("journal "+test.name, func(t *testing.T) {
			f := newTestFixture(t)
			created, err := f.store.Create(f.journal)
			if err != nil {
				t.Fatal(err)
			}
			journalPath := filepath.Join(f.root, created.TransactionID, journalName)
			test.tamper(t, journalPath)
			if _, err := f.store.Load(created.TransactionID); !errors.Is(err, ErrUnsafePath) {
				t.Fatalf("Load unsafe journal error = %v", err)
			}
		})
	}
}

func TestOpenHelperRejectsUnsafeTransactionLocks(t *testing.T) {
	for _, test := range []struct {
		name   string
		tamper func(t *testing.T, path string)
	}{
		{"symlink", func(t *testing.T, path string) {
			t.Helper()
			target := path + ".target"
			if err := os.WriteFile(target, nil, 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, path); err != nil {
				t.Fatal(err)
			}
		}},
		{"hardlink", func(t *testing.T, path string) {
			t.Helper()
			if err := os.Link(path, path+".hardlink"); err != nil {
				t.Fatal(err)
			}
		}},
		{"wide mode", func(t *testing.T, path string) {
			t.Helper()
			if err := os.Chmod(path, 0o640); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newTestFixture(t)
			created, err := f.store.Create(f.journal)
			if err != nil {
				t.Fatal(err)
			}
			lockPath := filepath.Join(f.root, created.TransactionID, transactionLockName)
			test.tamper(t, lockPath)
			if _, _, err := f.store.OpenHelper(created.TransactionID); !errors.Is(err, ErrUnsafePath) {
				t.Fatalf("OpenHelper unsafe transaction lock error = %v", err)
			}
		})
	}
}

func TestStoreDetectsTamperDuplicateFieldsAndMultipleNonterminal(t *testing.T) {
	t.Run("binding tamper", func(t *testing.T) {
		f := newTestFixture(t)
		created, err := f.store.Create(f.journal)
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(f.root, created.TransactionID, journalName)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		data = []byte(strings.Replace(string(data), `"compose_project": "ubitech-agent"`, `"compose_project": "evil-project"`, 1))
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := f.store.Load(created.TransactionID); err == nil {
			t.Fatal("Load accepted a tampered immutable binding")
		}
	})

	t.Run("duplicate JSON field", func(t *testing.T) {
		f := newTestFixture(t)
		created, err := f.store.Create(f.journal)
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(f.root, created.TransactionID, journalName)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		data = []byte(strings.Replace(string(data), "{\n", "{\n  \"revision\": 1,\n", 1))
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := f.store.Load(created.TransactionID); err == nil || !strings.Contains(err.Error(), "duplicate") {
			t.Fatalf("duplicate field error = %v", err)
		}
	})

	t.Run("multiple nonterminal", func(t *testing.T) {
		f := newTestFixture(t)
		if _, err := f.store.Create(f.journal); err != nil {
			t.Fatal(err)
		}
		second, err := NewJournal(f.journal.Release, f.journal.Source, f.journal.Target, f.journal.Evidence, f.now.Add(time.Minute))
		if err != nil {
			t.Fatal(err)
		}
		dir := filepath.Join(f.root, second.TransactionID)
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		encoded, err := json.MarshalIndent(second, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, transactionLockName), nil, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, journalName), append(encoded, '\n'), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, _, err := f.store.DiscoverNonTerminal(); !errors.Is(err, ErrMultipleNonTerminal) {
			t.Fatalf("Discover duplicate nonterminal error = %v", err)
		}
	})
}

func TestConcurrentCreateKeepsSingleNonterminal(t *testing.T) {
	f := newTestFixture(t)
	second, err := NewJournal(f.journal.Release, f.journal.Source, f.journal.Target, f.journal.Evidence, f.now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 2)
	var wait sync.WaitGroup
	for _, journal := range []Journal{f.journal, second} {
		journal := journal
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, createErr := f.store.Create(journal)
			results <- createErr
		}()
	}
	wait.Wait()
	close(results)
	successes := 0
	for createErr := range results {
		if createErr == nil {
			successes++
			continue
		}
		if !errors.Is(createErr, ErrBusy) && !errors.Is(createErr, ErrNonTerminalExists) {
			t.Fatalf("unexpected Create error: %v", createErr)
		}
	}
	if successes != 1 {
		t.Fatalf("concurrent Create successes=%d, want 1", successes)
	}
	if _, found, err := f.store.DiscoverNonTerminal(); err != nil || !found {
		t.Fatalf("Discover after concurrent Create = (found %v, %v)", found, err)
	}
}
