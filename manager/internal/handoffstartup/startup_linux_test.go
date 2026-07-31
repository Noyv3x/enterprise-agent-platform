//go:build linux

package handoffstartup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

const (
	testCommitA = "1111111111111111111111111111111111111111"
	testCommitB = "2222222222222222222222222222222222222222"
	testSHA     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
)

type startupChildSpec struct {
	Action         string   `json:"action"`
	TransactionDir string   `json:"transaction_dir"`
	StoreRoot      string   `json:"store_root"`
	SourceDataRoot string   `json:"source_data_root"`
	TargetDataRoot string   `json:"target_data_root"`
	Bindings       Bindings `json:"bindings"`
}

type startupFixture struct {
	t                *testing.T
	root             string
	storeRoot        string
	sourceData       string
	targetData       string
	sourceExecutable string
	targetExecutable string
	managerSHA       string
	bindings         Bindings
	store            *handoff.Store
	journal          handoff.Journal
	helper           *handoff.Helper
}

func TestStartupSubprocess(t *testing.T) {
	path := os.Getenv("HANDOFF_STARTUP_CHILD_SPEC")
	if path == "" {
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var spec startupChildSpec
	if err := json.Unmarshal(data, &spec); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var decision Decision
	switch spec.Action {
	case "bind-abort-and-wait":
		directory, openErr := os.Open(spec.TransactionDir)
		if openErr != nil {
			t.Fatal(openErr)
		}
		defer directory.Close()
		path := fmt.Sprintf("/proc/self/fd/%d/%s", directory.Fd(), AbortSourceSocketBasename)
		listener, listenErr := net.ListenUnix("unixpacket", &net.UnixAddr{Name: path, Net: "unixpacket"})
		if listenErr != nil {
			t.Fatal(listenErr)
		}
		listener.SetUnlinkOnClose(false)
		if chmodErr := os.Chmod(path, 0o600); chmodErr != nil {
			t.Fatal(chmodErr)
		}
		fmt.Fprintln(os.Stdout, "READY")
		select {}
	case "baseline":
		decision, err = RouteBaselineSource(spec.Bindings)
		if err != nil {
			t.Fatal(err)
		}
	case "baseline-authority":
		store, openErr := handoff.Open(spec.StoreRoot, spec.SourceDataRoot, spec.TargetDataRoot)
		if openErr != nil {
			t.Fatal(openErr)
		}
		defer store.Close()
		router, routeErr := NewTerminalRouter(store)
		if routeErr != nil {
			t.Fatal(routeErr)
		}
		var lease *AuthorityLease
		decision, lease, err = router.RouteBaselineSourceAuthorityRetained(ctx, spec.Bindings.Source)
		if err != nil {
			t.Fatal(err)
		}
		defer lease.Close()
	case "helper":
		router, err := NewHelperRouter(spec.Bindings)
		if err != nil {
			t.Fatal(err)
		}
		decision, err = router.RouteFromHelper(ctx, spec.TransactionDir)
		if err != nil {
			t.Fatal(err)
		}
	case "helper-unbound":
		router := NewCapabilityRouter()
		decision, err = router.RouteFromHelper(ctx, spec.TransactionDir)
		if err != nil {
			t.Fatal(err)
		}
	case "abort":
		router, err := NewHelperRouter(spec.Bindings)
		if err != nil {
			t.Fatal(err)
		}
		located, err := router.RouteFromHelperLocator(ctx, spec.TransactionDir)
		if err != nil {
			t.Fatal(err)
		}
		if located.Mode != HelperLocatorAbortSource || located.AbortSource == nil || located.Formal != nil {
			t.Fatalf("unexpected abort source locator decision: %+v", located)
		}
		fmt.Fprint(os.Stdout, located.Mode)
		return
	case "terminal":
		store, err := handoff.Open(spec.StoreRoot, spec.SourceDataRoot, spec.TargetDataRoot)
		if err != nil {
			t.Fatal(err)
		}
		defer store.Close()
		router, err := NewRouter(store, spec.Bindings)
		if err != nil {
			t.Fatal(err)
		}
		decision, err = router.RouteTerminal(ctx)
		if err != nil {
			t.Fatal(err)
		}
	case "terminal-authority":
		store, err := handoff.Open(spec.StoreRoot, spec.SourceDataRoot, spec.TargetDataRoot)
		if err != nil {
			t.Fatal(err)
		}
		defer store.Close()
		router, err := NewRouter(store, spec.Bindings)
		if err != nil {
			t.Fatal(err)
		}
		var lease *AuthorityLease
		decision, lease, err = router.RouteTerminalAuthorityRetained(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer lease.Close()
	case "terminal-unbound":
		store, err := handoff.OpenExisting(spec.StoreRoot)
		if err != nil {
			t.Fatal(err)
		}
		defer store.Close()
		router, err := NewTerminalRouter(store)
		if err != nil {
			t.Fatal(err)
		}
		decision, err = router.RouteTerminal(ctx)
		if err != nil {
			t.Fatal(err)
		}
	default:
		t.Fatalf("unknown startup child action %q", spec.Action)
	}
	fmt.Fprint(os.Stdout, decision.Profile.ProfileID)
}

func TestAbortSourceCapabilityRoutesOnlyRestrictedSourceAndRejectsReplay(t *testing.T) {
	fixture := newStartupFixture(t)
	defer fixture.close()
	transactionDir := filepath.Join(fixture.storeRoot, fixture.journal.TransactionID)
	issuer, err := NewAbortSourceIssuer(AbortSourceIssuerOptions{
		Lease: fixture.helper, TransactionDirectory: transactionDir, Bindings: fixture.bindings,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	command := fixture.childCommand("abort", fixture.sourceExecutable, transactionDir)
	var output strings.Builder
	command.Stdout, command.Stderr = &output, &output
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	consumption, serveErr := issuer.Serve(ctx)
	waitErr := command.Wait()
	if serveErr != nil || waitErr != nil {
		t.Fatalf("abort source startup failed: serve=%v child=%v output=%s", serveErr, waitErr, output.String())
	}
	if consumption.TransactionID != fixture.journal.TransactionID || consumption.Revision != fixture.journal.Revision || consumption.PID <= 1 ||
		!strings.Contains(output.String(), "abort_source") {
		t.Fatalf("abort source decision/consumption = %+v output=%q", consumption, output.String())
	}
	if _, err := issuer.Serve(ctx); !errors.Is(err, ErrCapabilityConsumed) {
		t.Fatalf("replayed abort issuer error = %v", err)
	}
	if _, err := os.Lstat(filepath.Join(transactionDir, AbortSourceSocketBasename)); !os.IsNotExist(err) {
		t.Fatalf("consumed abort socket still exists: %v", err)
	}
}

func TestHelperLocatorRejectsNoSocketAndDualSockets(t *testing.T) {
	fixture := newStartupFixture(t)
	defer fixture.close()
	transactionDir := filepath.Join(fixture.storeRoot, fixture.journal.TransactionID)
	router, err := NewHelperRouter(fixture.bindings)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := router.RouteFromHelperLocator(context.Background(), transactionDir); err == nil || !strings.Contains(err.Error(), "exactly one") {
		t.Fatalf("stale locator without a channel error = %v", err)
	}
	formal, err := NewIssuer(IssuerOptions{Lease: fixture.helper, TransactionDirectory: transactionDir, Bindings: fixture.bindings})
	if err != nil {
		t.Fatal(err)
	}
	defer formal.Close()
	directory, err := os.Open(transactionDir)
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	abortPath := fmt.Sprintf("/proc/self/fd/%d/%s", directory.Fd(), AbortSourceSocketBasename)
	abort, err := net.ListenUnix("unixpacket", &net.UnixAddr{Name: abortPath, Net: "unixpacket"})
	if err != nil {
		t.Fatal(err)
	}
	abort.SetUnlinkOnClose(true)
	defer abort.Close()
	if err := os.Chmod(abortPath, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := router.RouteFromHelperLocator(context.Background(), transactionDir); err == nil || !strings.Contains(err.Error(), "exactly one") {
		t.Fatalf("dual startup channel error = %v", err)
	}
}

func TestAbortIssuerRecoversSameRoleSocketAfterSIGKILLButStaleLocatorFailsClosed(t *testing.T) {
	fixture := newStartupFixture(t)
	defer fixture.close()
	transactionDir := filepath.Join(fixture.storeRoot, fixture.journal.TransactionID)
	command := fixture.childCommand("bind-abort-and-wait", fixture.sourceExecutable, transactionDir)
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	command.Stderr = command.Stdout
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	ready := make([]byte, len("READY\n"))
	if _, err := io.ReadFull(stdout, ready); err != nil || string(ready) != "READY\n" {
		t.Fatalf("wait for crash fixture: %q %v", ready, err)
	}
	if err := command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = command.Wait()
	router, err := NewHelperRouter(fixture.bindings)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := router.RouteFromHelperLocator(ctx, transactionDir); err == nil {
		t.Fatal("SIGKILL-stale locator was accepted without a live issuer")
	}
	issuer, err := NewAbortSourceIssuer(AbortSourceIssuerOptions{
		Lease: fixture.helper, TransactionDirectory: transactionDir, Bindings: fixture.bindings,
	})
	if err != nil {
		t.Fatalf("same-role SIGKILL recovery failed: %v", err)
	}
	defer issuer.Close()
	if info, err := os.Lstat(filepath.Join(transactionDir, AbortSourceSocketBasename)); err != nil || info.Mode()&os.ModeSocket == 0 {
		t.Fatalf("replacement abort issuer socket = %v %v", info, err)
	}
}

func TestBaselineRouteAcceptsOnlySourceStableExecutable(t *testing.T) {
	fixture := newStartupFixture(t)
	defer fixture.close()
	command := fixture.childCommand("baseline", fixture.sourceExecutable, "")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("baseline source route failed: %v: %s", err, output)
	}
	if !strings.Contains(string(output), identity.SourceProfile().ProfileID) {
		t.Fatalf("baseline source profile = %q", output)
	}
	command = fixture.childCommand("baseline", fixture.targetExecutable, "")
	if output, err = command.CombinedOutput(); err == nil {
		t.Fatalf("target executable obtained baseline source identity: %s", output)
	}
}

func TestBaselineAuthoritySelectsSourceWithoutPretendingWatchdogIsStable(t *testing.T) {
	fixture := newStartupFixtureWithoutJournal(t)
	defer fixture.close()
	command := fixture.childCommand("baseline-authority", "/proc/self/exe", "")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("baseline authority route failed: %v: %s", err, output)
	}
	if !strings.Contains(string(output), identity.SourceProfile().ProfileID) {
		t.Fatalf("baseline authority profile = %q", output)
	}
}

func TestHelperCapabilityRoutesTargetWithoutReacquiringStoreAndRejectsReplay(t *testing.T) {
	fixture := newStartupFixture(t)
	fixture.advanceTargetReady()
	defer fixture.close()
	transactionDir := filepath.Join(fixture.storeRoot, fixture.journal.TransactionID)
	issuer, err := NewIssuer(IssuerOptions{
		Lease: fixture.helper, TransactionDirectory: transactionDir, Bindings: fixture.bindings,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	command := fixture.childCommand("helper-unbound", fixture.targetExecutable, transactionDir)
	var output strings.Builder
	command.Stdout = &output
	command.Stderr = &output
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	serveErr := issuer.Serve(ctx)
	waitErr := command.Wait()
	if serveErr != nil || waitErr != nil {
		t.Fatalf("helper startup failed: serve=%v child=%v output=%s", serveErr, waitErr, output.String())
	}
	if !strings.HasPrefix(output.String(), identity.TargetProfile().ProfileID) {
		t.Fatalf("routed profile = %q", output.String())
	}
	if err := issuer.Serve(ctx); !errors.Is(err, ErrCapabilityConsumed) {
		t.Fatalf("replayed issuer error = %v", err)
	}
	if _, err := os.Lstat(filepath.Join(transactionDir, SocketBasename)); !os.IsNotExist(err) {
		t.Fatalf("consumed socket still exists: %v", err)
	}
}

func TestHelperCapabilityRestartsTargetAtForwardOnlyCommitCheckpoint(t *testing.T) {
	fixture := newStartupFixture(t)
	defer fixture.close()
	fixture.advanceTargetReady()
	fixture.advance(handoff.PhaseTargetStarted)
	issued := fixture.journal.UpdatedAt.Add(time.Second)
	fixture.mutateAt(issued, func(next *handoff.Journal) {
		next.TargetAck = &handoff.TargetAck{
			ManagerVersion: testCommitB, ExecutableSHA256: fixture.managerSHA, SourceCommit: testCommitB,
			PID: os.Getpid(), SocketPath: next.Target.SocketPath, AutoUpdateCheckAt: issued,
			IssuedAt: issued, ProofSHA256: testSHA,
		}
	})
	fixture.advance(handoff.PhaseTargetVerified)
	fixture.advance(handoff.PhaseSourceRetired)
	fixture.advance(handoff.PhaseTargetCommitPlanned)

	transactionDir := filepath.Join(fixture.storeRoot, fixture.journal.TransactionID)
	issuer, err := NewIssuer(IssuerOptions{Lease: fixture.helper, TransactionDirectory: transactionDir, Bindings: fixture.bindings})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	command := fixture.childCommand("helper", fixture.targetExecutable, transactionDir)
	var output strings.Builder
	command.Stdout, command.Stderr = &output, &output
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	serveErr, waitErr := issuer.Serve(ctx), command.Wait()
	if serveErr != nil || waitErr != nil || !strings.HasPrefix(output.String(), identity.TargetProfile().ProfileID) {
		t.Fatalf("target commit restart failed: serve=%v child=%v output=%q", serveErr, waitErr, output.String())
	}
}

func TestHelperCapabilityRoutesSourceOnlyDuringRollback(t *testing.T) {
	fixture := newStartupFixture(t)
	fixture.advanceRollbackSourceReady()
	defer fixture.close()
	transactionDir := filepath.Join(fixture.storeRoot, fixture.journal.TransactionID)
	issuer, err := NewIssuer(IssuerOptions{Lease: fixture.helper, TransactionDirectory: transactionDir, Bindings: fixture.bindings})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	command := fixture.childCommand("helper", fixture.sourceExecutable, transactionDir)
	var output strings.Builder
	command.Stdout, command.Stderr = &output, &output
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	serveErr := issuer.Serve(ctx)
	waitErr := command.Wait()
	if serveErr != nil || waitErr != nil {
		t.Fatalf("rollback startup failed: serve=%v child=%v output=%s", serveErr, waitErr, output.String())
	}
	if !strings.HasPrefix(output.String(), identity.SourceProfile().ProfileID) {
		t.Fatalf("routed profile = %q", output.String())
	}
}

func TestIssuerRejectsWrongExecutableAndDisallowedPhase(t *testing.T) {
	fixture := newStartupFixture(t)
	defer fixture.close()
	transactionDir := filepath.Join(fixture.storeRoot, fixture.journal.TransactionID)

	issuer, err := NewIssuer(IssuerOptions{Lease: fixture.helper, TransactionDirectory: transactionDir, Bindings: fixture.bindings})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- issuer.Serve(ctx) }()
	connection := dialTestChannel(t, transactionDir)
	request := startupRequest{SchemaVersion: SchemaVersion, TransactionID: fixture.journal.TransactionID, Nonce: strings.Repeat("1", 64)}
	encoded, _ := json.Marshal(request)
	if _, err := connection.Write(encoded); err != nil {
		t.Fatal(err)
	}
	_ = connection.Close()
	if err := <-result; err == nil || !strings.Contains(err.Error(), "cannot issue") {
		t.Fatalf("disallowed phase error = %v", err)
	}

	fixture.advanceTargetReady()
	issuer, err = NewIssuer(IssuerOptions{Lease: fixture.helper, TransactionDirectory: transactionDir, Bindings: fixture.bindings})
	if err != nil {
		t.Fatal(err)
	}
	result = make(chan error, 1)
	go func() { result <- issuer.Serve(ctx) }()
	connection = dialTestChannel(t, transactionDir)
	if _, err := connection.Write(encoded); err != nil {
		t.Fatal(err)
	}
	_ = connection.Close()
	if err := <-result; err == nil || !strings.Contains(err.Error(), "peer executable") {
		t.Fatalf("wrong executable error = %v", err)
	}
}

func TestTerminalRouterSelectsCommittedTarget(t *testing.T) {
	fixture := newStartupFixture(t)
	fixture.advanceCommitted()
	fixture.helper.Close()
	fixture.helper = nil
	fixture.store.Close()
	fixture.store = nil
	command := fixture.childCommand("terminal-unbound", fixture.targetExecutable, "")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("terminal target route: %v\n%s", err, output)
	}
	if !strings.HasPrefix(string(output), identity.TargetProfile().ProfileID) {
		t.Fatalf("terminal profile = %q", output)
	}
}

func TestTerminalAuthoritySelectsCommittedTargetForBoundWatchdog(t *testing.T) {
	fixture := newStartupFixture(t)
	fixture.advanceCommitted()
	fixture.helper.Close()
	fixture.helper = nil
	fixture.store.Close()
	fixture.store = nil
	command := fixture.childCommand("terminal-authority", "/proc/self/exe", "")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("terminal authority route: %v\n%s", err, output)
	}
	if !strings.HasPrefix(string(output), identity.TargetProfile().ProfileID) {
		t.Fatalf("terminal authority profile = %q", output)
	}
}

func TestTerminalRouterSelectsSourceWithoutHandoff(t *testing.T) {
	fixture := newStartupFixtureWithoutJournal(t)
	fixture.store.Close()
	fixture.store = nil
	command := fixture.childCommand("terminal", fixture.sourceExecutable, "")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("terminal source route: %v\n%s", err, output)
	}
	if !strings.HasPrefix(string(output), identity.SourceProfile().ProfileID) {
		t.Fatalf("terminal profile = %q", output)
	}
}

func TestTerminalRouterRejectsNonterminalWithoutHelperSnapshot(t *testing.T) {
	fixture := newStartupFixture(t)
	fixture.helper.Close()
	fixture.helper = nil
	router, err := NewRouter(fixture.store, fixture.bindings)
	if err != nil {
		t.Fatal(err)
	}
	_, err = router.RouteTerminal(context.Background())
	if !errors.Is(err, ErrCapabilityRequired) {
		t.Fatalf("terminal nonterminal error = %v", err)
	}
}

func TestRetainedBaselineAuthorityBlocksHandoffPublicationUntilReleased(t *testing.T) {
	fixture := newStartupFixtureWithoutJournal(t)
	defer fixture.close()
	router, err := NewTerminalRouter(fixture.store)
	if err != nil {
		t.Fatal(err)
	}
	decision, lease, err := router.RouteBaselineSourceAuthorityRetained(context.Background(), fixture.bindings.Source)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	if decision.ActiveProfile != identity.SourceActiveProfile() || decision.TransactionID != "" {
		t.Fatalf("unexpected retained baseline decision: %+v", decision)
	}
	builderRan := false
	if _, _, err := fixture.store.CreatePlanned(func() (handoff.Journal, error) {
		builderRan = true
		return handoff.Journal{}, nil
	}); !errors.Is(err, handoff.ErrBusy) {
		t.Fatalf("handoff publication while authority was retained = %v", err)
	}
	if builderRan {
		t.Fatal("handoff builder ran while the retained authority lease was held")
	}
	if err := lease.Revalidate(context.Background()); err != nil {
		t.Fatalf("revalidate retained baseline authority: %v", err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	want := errors.New("builder reached after authority release")
	if _, _, err := fixture.store.CreatePlanned(func() (handoff.Journal, error) {
		builderRan = true
		return handoff.Journal{}, want
	}); !errors.Is(err, want) {
		t.Fatalf("handoff publication did not acquire the released lease: %v", err)
	}
	if !builderRan {
		t.Fatal("handoff builder did not run after authority release")
	}
}

func TestRuntimePathValidationAllowsOnlySourceConfigToBeArbitrary(t *testing.T) {
	fixture := newStartupFixtureWithoutJournal(t)
	defer fixture.close()
	source := fixture.bindings.Source
	source.ConfigPath = filepath.Join(fixture.root, "custom", "p1-installed.toml")
	if err := validateRuntimePaths("source", identity.SourceProfile(), source); err != nil {
		t.Fatalf("arbitrary source config was rejected: %v", err)
	}
	target := fixture.bindings.Target
	target.ConfigPath = filepath.Join(fixture.root, "custom", "target.toml")
	if err := validateRuntimePaths("target", identity.TargetProfile(), target); err == nil || !strings.Contains(err.Error(), "config path") {
		t.Fatalf("arbitrary target config was accepted: %v", err)
	}
}

func TestClosedJSONAndSnapshotValidationRejectMalice(t *testing.T) {
	var request startupRequest
	for _, raw := range []string{
		`{"schema_version":1,"transaction_id":"handoff_11111111111111111111111111111111","nonce":"` + strings.Repeat("1", 64) + `","extra":true}`,
		`{"schema_version":1,"schema_version":1,"transaction_id":"handoff_11111111111111111111111111111111","nonce":"` + strings.Repeat("1", 64) + `"}`,
		`{"schema_version":1,"transaction_id":"handoff_11111111111111111111111111111111","nonce":"` + strings.Repeat("1", 64) + `"} {}`,
	} {
		if err := decodeExactJSON([]byte(raw), &request, requestFields); err == nil {
			t.Fatalf("accepted malicious JSON: %s", raw)
		}
	}
	fixture := newStartupFixtureWithoutJournal(t)
	router, err := newHelperRouter(fixture.bindings, func() time.Time { return time.Unix(100, 0).UTC() }, currentPID)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := StartupSnapshot{
		SchemaVersion: SchemaVersion, TransactionID: "handoff_11111111111111111111111111111111", Revision: 1,
		BindingSHA256: testSHA, Nonce: strings.Repeat("1", 64), ProfileID: identity.SourceProfile().ProfileID,
		Status: handoff.StatusRunning, Phase: handoff.PhaseDataRelocated, DesiredOutcome: handoff.OutcomeForward,
		Generation: testCommitB, ManagerSHA256: fixture.managerSHA, StableBinary: fixture.bindings.Source.StableBinary,
		ConfigPath: fixture.bindings.Source.ConfigPath, ConfigSHA256: testSHA, DataRoot: fixture.bindings.Source.DataRoot,
		StateRoot: fixture.bindings.Source.StateRoot, SocketPath: fixture.bindings.Source.SocketPath,
		ComposeProject: identity.SourceProfile().ComposeProject, CoreNetwork: identity.SourceProfile().CoreNetwork,
		IssuedAt: time.Unix(99, 0).UTC(), ExpiresAt: time.Unix(110, 0).UTC(),
	}
	if _, err := router.decisionFromSnapshot(snapshot, snapshot.TransactionID, snapshot.Nonce); err == nil || !strings.Contains(err.Error(), "source startup") {
		t.Fatalf("wrong-profile snapshot error = %v", err)
	}
	snapshot.ProfileID = identity.TargetProfile().ProfileID
	snapshot.StableBinary = fixture.bindings.Target.StableBinary
	snapshot.ConfigPath = fixture.bindings.Target.ConfigPath
	snapshot.DataRoot = fixture.bindings.Target.DataRoot
	snapshot.StateRoot = fixture.bindings.Target.StateRoot
	snapshot.SocketPath = fixture.bindings.Target.SocketPath
	snapshot.ComposeProject = identity.TargetProfile().ComposeProject
	snapshot.CoreNetwork = identity.TargetProfile().CoreNetwork
	snapshot.ExpiresAt = time.Unix(100, 0).UTC()
	if _, err := router.decisionFromSnapshot(snapshot, snapshot.TransactionID, snapshot.Nonce); err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("expired snapshot error = %v", err)
	}
}

func TestIssuerHonorsCancellationAndRemovesSocket(t *testing.T) {
	fixture := newStartupFixture(t)
	fixture.advanceTargetReady()
	defer fixture.close()
	transactionDir := filepath.Join(fixture.storeRoot, fixture.journal.TransactionID)
	issuer, err := NewIssuer(IssuerOptions{Lease: fixture.helper, TransactionDirectory: transactionDir, Bindings: fixture.bindings})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := issuer.Serve(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Serve cancellation error = %v", err)
	}
	if _, err := os.Lstat(filepath.Join(transactionDir, SocketBasename)); !os.IsNotExist(err) {
		t.Fatalf("cancelled issuer socket still exists: %v", err)
	}
}

func TestIssuerRejectsSymlinkedTransactionAndPreexistingSocket(t *testing.T) {
	fixture := newStartupFixture(t)
	defer fixture.close()
	realDirectory := filepath.Join(fixture.storeRoot, fixture.journal.TransactionID)
	aliasParent := filepath.Join(fixture.root, "alias")
	mustMkdir(t, aliasParent)
	aliasDirectory := filepath.Join(aliasParent, fixture.journal.TransactionID)
	if err := os.Symlink(realDirectory, aliasDirectory); err != nil {
		t.Fatal(err)
	}
	if issuer, err := NewIssuer(IssuerOptions{Lease: fixture.helper, TransactionDirectory: aliasDirectory, Bindings: fixture.bindings}); err == nil {
		_ = issuer.Close()
		t.Fatal("symlinked transaction directory was accepted")
	}
	preexisting := filepath.Join(realDirectory, SocketBasename)
	if err := os.Symlink(filepath.Join(fixture.root, "not-a-socket"), preexisting); err != nil {
		t.Fatal(err)
	}
	if issuer, err := NewIssuer(IssuerOptions{Lease: fixture.helper, TransactionDirectory: realDirectory, Bindings: fixture.bindings}); err == nil {
		_ = issuer.Close()
		t.Fatal("preexisting startup socket symlink was accepted")
	}
	info, err := os.Lstat(preexisting)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("preexisting symlink was modified: info=%v err=%v", info, err)
	}
}

func newStartupFixture(t *testing.T) *startupFixture {
	fixture := newStartupFixtureWithoutJournal(t)
	now := time.Unix(1_800_000_000, 0).UTC()
	journal, err := handoff.NewJournal(
		handoff.ReleaseBinding{
			PredecessorGeneration: testCommitA, BridgeGeneration: testCommitB,
			ManifestPath: filepath.Join(identity.SourceProfile().ManagerStateRoot(fixture.sourceData), "releases", testCommitB, "manifest.json"), ManifestSHA256: testSHA,
			TargetManagerSHA256: fixture.managerSHA, TargetManagerVersion: testCommitB, TargetComposeSHA256: testSHA,
		},
		handoff.SourceBinding{
			Namespace: identity.SourceProfile().ProfileID, Unit: identity.SourceProfile().ManagerUnit, UnitEnabled: true,
			UnitPath: filepath.Join(fixture.root, "systemd", identity.SourceProfile().ManagerUnit), UnitSHA256: testSHA,
			StableBinary: fixture.bindings.Source.StableBinary, StableSHA256: fixture.managerSHA,
			ConfigPath: fixture.bindings.Source.ConfigPath, ConfigSHA256: testSHA,
			ManifestPath: filepath.Join(identity.SourceProfile().ManagerStateRoot(fixture.sourceData), "releases", testCommitA, "manifest.json"), ManifestSHA256: testSHA,
			ComposePath: filepath.Join(identity.SourceProfile().ManagerStateRoot(fixture.sourceData), "releases", testCommitA, "compose.yaml"), ComposeSHA256: testSHA,
			DataRoot:   fixture.sourceData,
			SocketPath: fixture.bindings.Source.SocketPath, ComposeProject: identity.SourceProfile().ComposeProject,
			CoreNetwork: identity.SourceProfile().CoreNetwork, CoreNetworkID: "aaaaaaaaaaaa", LabelPrefix: identity.SourceProfile().LabelPrefix,
		},
		handoff.TargetBinding{
			Namespace: identity.TargetProfile().ProfileID, Unit: identity.TargetProfile().ManagerUnit,
			UnitPath:     filepath.Join(fixture.root, "systemd", identity.TargetProfile().ManagerUnit),
			StableBinary: fixture.bindings.Target.StableBinary, ConfigPath: fixture.bindings.Target.ConfigPath, ConfigSHA256: testSHA,
			DataRoot: fixture.targetData, SocketPath: fixture.bindings.Target.SocketPath,
			ComposeProject: identity.TargetProfile().ComposeProject, CoreNetwork: identity.TargetProfile().CoreNetwork,
			LabelPrefix: identity.TargetProfile().LabelPrefix,
		},
		handoff.Evidence{
			ManagerStateSHA256: testSHA, SelfUpdateStateSHA256: testSHA, SandboxRegistrySHA256: testSHA,
			DockerInventorySHA256: testSHA, DatabaseSchemaVersion: 1, DatabaseIntegrity: "ok",
			RuntimeIdentitySHA256: testSHA, WorkspaceIdentitySHA256: testSHA,
			BootID: "11111111-1111-1111-1111-111111111111",
		}, now,
	)
	if err != nil {
		t.Fatal(err)
	}
	created, err := fixture.store.Create(journal)
	if err != nil {
		t.Fatal(err)
	}
	helper, loaded, err := fixture.store.OpenHelper(created.TransactionID)
	if err != nil {
		t.Fatal(err)
	}
	fixture.journal, fixture.helper = loaded, helper
	return fixture
}

func newStartupFixtureWithoutJournal(t *testing.T) *startupFixture {
	t.Helper()
	root := t.TempDir()
	for _, directory := range []string{"bin", "data", "config", "runtime", "state-home", "systemd"} {
		mustMkdir(t, filepath.Join(root, directory))
	}
	sourceProfile, targetProfile := identity.SourceProfile(), identity.TargetProfile()
	sourceData := filepath.Join(root, "data", sourceProfile.DataDirectory)
	targetData := filepath.Join(root, "data", targetProfile.DataDirectory)
	sourceState := sourceProfile.ManagerStateRoot(sourceData)
	targetState := targetProfile.ManagerStateRoot(targetData)
	sourceControl := filepath.Join(sourceState, "control")
	targetControl := filepath.Join(root, "runtime", "agent-platform-manager")
	for _, directory := range []string{sourceData, targetData, sourceState, targetState, sourceControl, targetControl,
		filepath.Join(root, "config", sourceProfile.ConfigDirectory), filepath.Join(root, "config", targetProfile.ConfigDirectory)} {
		mustMkdir(t, directory)
	}
	sourceExecutable := filepath.Join(root, "bin", sourceProfile.ManagerBinary)
	targetExecutable := filepath.Join(root, "bin", targetProfile.ManagerBinary)
	copySelf(t, sourceExecutable)
	copySelf(t, targetExecutable)
	managerSHA := digestPath(t, targetExecutable)
	sourceConfig := filepath.Join(root, "config", sourceProfile.ConfigDirectory, sourceProfile.ConfigFile)
	targetConfig := filepath.Join(root, "config", targetProfile.ConfigDirectory, targetProfile.ConfigFile)
	if err := os.WriteFile(sourceConfig, []byte("source\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(targetConfig, []byte("target\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	bindings := Bindings{
		Source: RuntimePaths{
			StableBinary: sourceExecutable, ConfigPath: sourceConfig, DataRoot: sourceData, StateRoot: sourceState,
			SocketPath: filepath.Join(sourceControl, "manager.sock"),
		},
		Target: RuntimePaths{
			StableBinary: targetExecutable, ConfigPath: targetConfig, DataRoot: targetData, StateRoot: targetState,
			SocketPath: filepath.Join(targetControl, "manager.sock"),
		},
	}
	storeRoot := filepath.Join(root, "state-home", "agent-platform", "handoff")
	store, err := handoff.Open(storeRoot, sourceData, targetData)
	if err != nil {
		t.Fatal(err)
	}
	return &startupFixture{
		t: t, root: root, storeRoot: storeRoot, sourceData: sourceData, targetData: targetData,
		sourceExecutable: sourceExecutable, targetExecutable: targetExecutable, managerSHA: managerSHA,
		bindings: bindings, store: store,
	}
}

func (fixture *startupFixture) advanceTargetReady() {
	fixture.t.Helper()
	fixture.persistHelperEvidence()
	fixture.advance(handoff.PhaseHelperArmed)
	fixture.advance(handoff.PhaseAdmissionReserved)
	fixture.advance(handoff.PhaseWritersStopped)
	fixture.mutate(func(next *handoff.Journal) {
		next.Snapshot = &handoff.Snapshot{Path: filepath.Join(fixture.root, "snapshot"), ManifestSHA256: testSHA}
	})
	fixture.advance(handoff.PhaseSnapshotReady)
	fixture.advance(handoff.PhaseSourceFenced)
	fixture.advance(handoff.PhaseTargetStaged)
	fixture.advance(handoff.PhaseDataRelocated)
}

func (fixture *startupFixture) advanceRollbackSourceReady() {
	fixture.advanceTargetReady()
	fixture.mutate(func(next *handoff.Journal) { next.Error = "test rollback" })
	if fixture.journal.Phase != handoff.PhaseRollbackPlanned {
		fixture.t.Fatalf("rollback phase = %s", fixture.journal.Phase)
	}
	fixture.advance(handoff.PhaseTargetStopped)
	fixture.advance(handoff.PhaseDataRestored)
}

func (fixture *startupFixture) advanceCommitted() {
	fixture.advanceTargetReady()
	fixture.advance(handoff.PhaseTargetStarted)
	issued := fixture.journal.UpdatedAt.Add(time.Second)
	fixture.mutateAt(issued, func(next *handoff.Journal) {
		next.TargetAck = &handoff.TargetAck{
			ManagerVersion: testCommitB, ExecutableSHA256: fixture.managerSHA, SourceCommit: testCommitB,
			PID: os.Getpid(), SocketPath: next.Target.SocketPath,
			AutoUpdateCheckAt: issued, IssuedAt: issued, ProofSHA256: testSHA,
		}
	})
	fixture.advance(handoff.PhaseTargetVerified)
	fixture.advance(handoff.PhaseSourceRetired)
	fixture.advance(handoff.PhaseTargetCommitPlanned)
	fixture.mutate(func(next *handoff.Journal) {
		receipt := handoff.TargetPlatformCommit{
			SchemaVersion: 1, OperationID: next.TransactionID,
			TargetGeneration: next.Release.BridgeGeneration, BindingSHA256: next.BindingSHA256,
			DatabaseSchemaVersion: next.Evidence.DatabaseSchemaVersion, CommittedAt: fixture.journal.UpdatedAt.Add(time.Second).Format(time.RFC3339Nano),
		}
		receipt.ReceiptSHA256, _ = handoff.ComputeTargetPlatformCommitSHA256(receipt)
		next.TargetPlatformCommit = &receipt
		next.Phase = handoff.PhaseCommitted
		next.Status = handoff.StatusCommitted
	})
}

func (fixture *startupFixture) persistHelperEvidence() {
	suffix := strings.TrimPrefix(fixture.journal.TransactionID, "handoff_")[:12]
	fixture.mutate(func(next *handoff.Journal) {
		next.Helper = &handoff.HelperEvidence{
			Unit:       identity.TargetProfile().DataDirectory + "-namespace-handoff-" + suffix + ".service",
			UnitSHA256: testSHA, Executable: fixture.targetExecutable, SHA256: fixture.managerSHA,
			ArgvSHA256: testSHA, ControlGroup: "/test/helper",
		}
	})
}

func (fixture *startupFixture) advance(phase handoff.Phase) {
	fixture.mutate(func(next *handoff.Journal) { next.Phase = phase })
}

func (fixture *startupFixture) mutate(change func(*handoff.Journal)) {
	fixture.mutateAt(fixture.journal.UpdatedAt.Add(time.Second), change)
}

func (fixture *startupFixture) mutateAt(at time.Time, change func(*handoff.Journal)) {
	fixture.t.Helper()
	updated, err := fixture.helper.Mutate(fixture.journal.Revision, at, func(next *handoff.Journal) error {
		change(next)
		return nil
	})
	if err != nil {
		fixture.t.Fatal(err)
	}
	fixture.journal = updated
}

func (fixture *startupFixture) childCommand(action, executable, transactionDir string) *exec.Cmd {
	fixture.t.Helper()
	spec := startupChildSpec{
		Action: action, TransactionDir: transactionDir, StoreRoot: fixture.storeRoot,
		SourceDataRoot: fixture.sourceData, TargetDataRoot: fixture.targetData, Bindings: fixture.bindings,
	}
	data, err := json.Marshal(spec)
	if err != nil {
		fixture.t.Fatal(err)
	}
	path := filepath.Join(fixture.root, "child-"+action+".json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		fixture.t.Fatal(err)
	}
	command := exec.Command(executable, "-test.run=^TestStartupSubprocess$", "-test.v=false")
	command.Env = append(os.Environ(), "HANDOFF_STARTUP_CHILD_SPEC="+path)
	return command
}

func (fixture *startupFixture) close() {
	if fixture.helper != nil {
		_ = fixture.helper.Close()
	}
	if fixture.store != nil {
		_ = fixture.store.Close()
	}
}

func dialTestChannel(t *testing.T, transactionDir string) *net.UnixConn {
	t.Helper()
	directory, err := openDirectoryNoFollow(transactionDir, true)
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	path := fmt.Sprintf("/proc/self/fd/%d/%s", directory.Fd(), SocketBasename)
	raw, err := net.Dial("unixpacket", path)
	if err != nil {
		t.Fatal(err)
	}
	connection, ok := raw.(*net.UnixConn)
	if !ok {
		t.Fatal("not a Unix connection")
	}
	return connection
}

func mustMkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o700); err != nil {
		t.Fatal(err)
	}
}

func copySelf(t *testing.T, destination string) {
	t.Helper()
	source, err := os.Open("/proc/self/exe")
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	target, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o700)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(target, source); err != nil {
		_ = target.Close()
		t.Fatal(err)
	}
	if err := target.Close(); err != nil {
		t.Fatal(err)
	}
}

func digestPath(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}
