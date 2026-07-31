//go:build linux

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

type deniedHandoffMutationAdmission struct{ calls int }

func (admission *deniedHandoffMutationAdmission) Acquire(context.Context) (func(), error) {
	admission.calls++
	return nil, errors.New("handoff mutation denied")
}

func newBackgroundHandoffStore(t *testing.T) (*handoff.Store, handoff.Journal) {
	t.Helper()
	base := t.TempDir()
	stateHome := filepath.Join(base, "state-home")
	sourceRoot := filepath.Join(base, identity.SourceProfile().DataDirectory)
	targetRoot := filepath.Join(base, identity.TargetProfile().DataDirectory)
	for _, path := range []string{stateHome, sourceRoot} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	root := filepath.Join(stateHome, "agent-platform", "handoff")
	store, err := handoff.Open(root, sourceRoot, targetRoot)
	if err != nil {
		t.Fatalf("open handoff store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	sourceProfile, targetProfile := identity.SourceProfile(), identity.TargetProfile()
	sha := strings.Repeat("a", 64)
	bridge := strings.Repeat("b", 40)
	now := time.Now().UTC()
	journal, err := handoff.NewJournal(
		handoff.ReleaseBinding{
			PredecessorGeneration: strings.Repeat("c", 40), BridgeGeneration: bridge,
			ManifestPath: filepath.Join(sourceProfile.ManagerStateRoot(sourceRoot), "releases", bridge, "manifest.json"), ManifestSHA256: sha,
			TargetManagerSHA256: sha, TargetManagerVersion: bridge, TargetComposeSHA256: sha,
		},
		handoff.SourceBinding{
			Namespace: sourceProfile.ProfileID, Unit: sourceProfile.ManagerUnit, UnitEnabled: true,
			UnitPath: filepath.Join(base, "systemd", sourceProfile.ManagerUnit), UnitSHA256: sha,
			StableBinary: filepath.Join(base, "bin", sourceProfile.ManagerBinary), StableSHA256: sha,
			ConfigPath: filepath.Join(base, "config", sourceProfile.ConfigDirectory, sourceProfile.ConfigFile), ConfigSHA256: sha,
			ManifestPath: filepath.Join(sourceProfile.ManagerStateRoot(sourceRoot), "releases", strings.Repeat("c", 40), "manifest.json"), ManifestSHA256: sha,
			ComposePath: filepath.Join(sourceProfile.ManagerStateRoot(sourceRoot), "releases", strings.Repeat("c", 40), "compose.yaml"), ComposeSHA256: sha,
			DataRoot: sourceRoot, SocketPath: filepath.Join(sourceRoot, "manager", "control", "manager.sock"),
			ComposeProject: sourceProfile.ComposeProject, CoreNetwork: sourceProfile.CoreNetwork,
			CoreNetworkID: strings.Repeat("d", 64), LabelPrefix: sourceProfile.LabelPrefix,
		},
		handoff.TargetBinding{
			Namespace: targetProfile.ProfileID, Unit: targetProfile.ManagerUnit,
			UnitPath:     filepath.Join(base, "systemd", targetProfile.ManagerUnit),
			StableBinary: filepath.Join(base, "bin", targetProfile.ManagerBinary),
			ConfigPath:   filepath.Join(base, "config", targetProfile.ConfigDirectory, targetProfile.ConfigFile),
			ConfigSHA256: sha,
			DataRoot:     targetRoot, SocketPath: filepath.Join(base, "runtime", filepath.FromSlash(targetProfile.RuntimeSocketPath)),
			ComposeProject: targetProfile.ComposeProject, CoreNetwork: targetProfile.CoreNetwork, LabelPrefix: targetProfile.LabelPrefix,
		},
		handoff.Evidence{
			ManagerStateSHA256: sha, SelfUpdateStateSHA256: sha, SandboxRegistrySHA256: sha,
			DockerInventorySHA256: sha, DatabaseSchemaVersion: 27, DatabaseIntegrity: "ok",
			RuntimeIdentitySHA256: sha, WorkspaceIdentitySHA256: sha,
			BootID: "12345678-1234-1234-1234-123456789abc",
		},
		now,
	)
	if err != nil {
		t.Fatalf("create handoff journal value: %v", err)
	}
	created, err := store.Create(journal)
	if err != nil {
		t.Fatalf("persist handoff journal: %v", err)
	}
	return store, created
}

func abortBackgroundHandoff(t *testing.T, store *handoff.Store, current handoff.Journal) {
	t.Helper()
	helper, current, err := store.OpenHelper(current.TransactionID)
	if err != nil {
		t.Fatalf("open handoff helper: %v", err)
	}
	defer helper.Close()
	now := time.Now().UTC()
	current, err = helper.Mutate(current.Revision, now, func(journal *handoff.Journal) error {
		journal.AbortCleanup = &handoff.AbortCleanup{
			ReservationReleased: true, StagingRemoved: true,
			ListenersRestored: true, SourceIdentityVerified: true, SourcePublicReady: true,
		}
		return nil
	})
	if err != nil {
		t.Fatalf("persist abort cleanup: %v", err)
	}
	_, err = helper.Mutate(current.Revision, now.Add(time.Second), func(journal *handoff.Journal) error {
		journal.DesiredOutcome = handoff.OutcomeRollback
		journal.Phase = handoff.PhaseAborted
		journal.Status = handoff.StatusAborted
		return nil
	})
	if err != nil {
		t.Fatalf("terminally abort handoff: %v", err)
	}
}

func TestBackgroundMaintenanceStopsAtNonterminalHandoffAndResumesAfterTerminal(t *testing.T) {
	cleanup := &recordingMaintenanceCleanup{}
	app, _ := newMaintenanceTestApplication(t, cleanup, nil)
	handoffStore, active := newBackgroundHandoffStore(t)
	app.handoffAdmission = &routedHandoffAdmission{store: handoffStore}

	if err := app.reconcileMaintenance(context.Background()); err == nil ||
		!strings.Contains(err.Error(), "active namespace handoff") {
		t.Fatalf("nonterminal handoff maintenance error = %v", err)
	}
	if len(cleanup.calls) != 0 {
		t.Fatalf("maintenance wrote during nonterminal handoff: %#v", cleanup.calls)
	}

	abortBackgroundHandoff(t, handoffStore, active)
	if err := app.reconcileMaintenance(context.Background()); err != nil {
		t.Fatalf("maintenance did not resume after terminal handoff: %v", err)
	}
	if got := strings.Join(cleanup.calls, ","); got != "snapshots,releases-and-images,operations,manager-versions" {
		t.Fatalf("terminal handoff maintenance calls = %q", got)
	}
}

func TestBackgroundMutationFailsClosedWithoutAdmission(t *testing.T) {
	called := false
	app := &application{}
	if err := app.withHandoffMutation(context.Background(), func() error {
		called = true
		return nil
	}); err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("missing background admission error = %v", err)
	}
	if called {
		t.Fatal("background mutation ran without handoff admission")
	}
}

func TestPreflightDoesNotRunAnyMutationDuringNonterminalHandoff(t *testing.T) {
	store, _ := newBackgroundHandoffStore(t)
	marker := filepath.Join(t.TempDir(), "preflight-side-effect")
	err := preflightUnderHandoffAdmission(context.Background(), store, func() error {
		return os.WriteFile(marker, []byte("must-not-run"), 0o600)
	})
	if err == nil || !strings.Contains(err.Error(), "active namespace handoff") {
		t.Fatalf("preflight admission error = %v", err)
	}
	if _, statErr := os.Lstat(marker); !os.IsNotExist(statErr) {
		t.Fatalf("preflight side effect exists after denied admission: %v", statErr)
	}
}

func TestPreflightRetainsGlobalHandoffLeaseAcrossEveryMutation(t *testing.T) {
	store, active := newBackgroundHandoffStore(t)
	abortBackgroundHandoff(t, store, active)
	actionRan := false
	err := preflightUnderHandoffAdmission(context.Background(), store, func() error {
		actionRan = true
		_, _, createErr := store.CreatePlanned(func() (handoff.Journal, error) {
			t.Fatal("concurrent handoff builder ran while preflight held admission")
			return handoff.Journal{}, nil
		})
		if !errors.Is(createErr, handoff.ErrBusy) {
			return errors.New("concurrent handoff did not remain outside the preflight publication boundary")
		}
		return nil
	})
	if err != nil {
		t.Fatalf("preflight under terminal admission: %v", err)
	}
	if !actionRan {
		t.Fatal("preflight action did not run after terminal admission")
	}
}

func TestEveryApplicationBackgroundWriterEntersHandoffAdmissionFirst(t *testing.T) {
	tests := map[string]func(*application) error{
		"capabilities": func(app *application) error { return app.reconcileCapabilities(context.Background()) },
		"firecrawl":    func(app *application) error { return app.reconcileFirecrawl(context.Background()) },
		"maintenance":  func(app *application) error { return app.reconcileMaintenance(context.Background()) },
		"sandboxes":    func(app *application) error { return app.reconcileSandboxes(context.Background(), time.Now()) },
	}
	for name, run := range tests {
		t.Run(name, func(t *testing.T) {
			admission := &deniedHandoffMutationAdmission{}
			app := &application{handoffAdmission: admission}
			if err := run(app); err == nil || !strings.Contains(err.Error(), "handoff mutation denied") {
				t.Fatalf("background writer error = %v", err)
			}
			if admission.calls != 1 {
				t.Fatalf("handoff admission calls = %d, want 1", admission.calls)
			}
		})
	}
}
