//go:build linux

package handoffevidence

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffsource"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/journal"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/maintenance"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/runtimegate"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/sandbox"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/selfupdate"
)

type admissionUnits struct{ active []string }

func (units admissionUnits) Show(context.Context, string) (handoffsource.UnitState, error) {
	return handoffsource.UnitState{}, nil
}
func (units admissionUnits) ActiveUnits(context.Context, []string) ([]string, error) {
	return append([]string(nil), units.active...), nil
}

type admissionSandboxes struct{ records []sandbox.Record }

func (value admissionSandboxes) Records() []sandbox.Record {
	return append([]sandbox.Record(nil), value.records...)
}

func TestProductionAdmissionFreezesRuntimeAndObservesClosedBoundary(t *testing.T) {
	admission, runtimeGate := newAdmissionFixture(t, admissionSandboxes{})
	lease, err := admission.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !runtimeGate.Frozen() {
		t.Fatal("runtime was not frozen")
	}
	if release, err := runtimeGate.Enter(context.Background()); err == nil {
		release()
		t.Fatal("new executor call crossed the observation boundary")
	}
	observation, err := lease.Observe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !observation.Idle || observation.ActiveExecutionCount != 0 || observation.Generation != strings.Repeat("a", 40) {
		t.Fatalf("unexpected observation: %+v", observation)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	if runtimeGate.Frozen() {
		t.Fatal("runtime remained frozen after close")
	}
	if release, err := runtimeGate.Enter(context.Background()); err != nil {
		t.Fatalf("runtime admission did not reopen: %v", err)
	} else {
		release()
	}
}

func TestProductionAdmissionRejectsActivityAndContextBoundMaintenance(t *testing.T) {
	admission, runtimeGate := newAdmissionFixture(t, admissionSandboxes{records: []sandbox.Record{{
		SandboxID: "sandbox-a", ActiveCalls: 1,
	}}})
	lease, err := admission.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	observation, err := lease.Observe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if observation.Idle || observation.ActiveExecutionCount != 1 {
		t.Fatalf("sandbox activity was not reflected: %+v", observation)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}

	admission.maintenance.TryLock()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := admission.Acquire(ctx); err == nil {
		t.Fatal("contended maintenance admission ignored context deadline")
	}
	admission.maintenance.Unlock()
	if runtimeGate.Frozen() {
		t.Fatal("failed acquisition leaked the runtime freeze")
	}
}

func newAdmissionFixture(t *testing.T, sandboxes admissionSandboxes) (*ProductionAdmission, *runtimegate.Gate) {
	t.Helper()
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	stateDir := filepath.Join(root, "manager")
	if err := os.Mkdir(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	store, err := journal.Open(stateDir, time.Unix(1, 0))
	if err != nil {
		t.Fatal(err)
	}
	generation := strings.Repeat("a", 40)
	if _, err := store.MutateState(time.Unix(2, 0), func(state *model.ManagerState) error {
		state.Current = &model.Generation{ID: generation, SourceCommit: generation}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	selfPath := filepath.Join(stateDir, "manager-binaries.json")
	managerSHA := strings.Repeat("b", 64)
	selfState := selfupdate.State{SchemaVersion: 1, Current: &selfupdate.Version{
		Version: generation, SourceCommit: generation, Path: filepath.Join(root, "manager-bin"),
		SHA256: managerSHA, VerifiedAt: time.Unix(2, 0).UTC(), PlatformCommitted: true,
	}, UpdatedAt: time.Unix(2, 0).UTC()}
	if err := atomicfile.WriteJSON(selfPath, selfState, 0o600); err != nil {
		t.Fatal(err)
	}
	selfRoot := filepath.Join(stateDir, "manager-binaries")
	if err := os.Mkdir(selfRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	runtimeGate := runtimegate.New()
	value, err := NewAdmission(AdmissionOptions{
		Profile: identity.SourceActiveProfile(), Runtime: runtimeGate,
		Maintenance: &maintenance.Admission{}, Journal: store,
		SelfUpdate: &selfupdate.Manager{Root: selfRoot, StatePath: selfPath},
		Units:      admissionUnits{}, Sandboxes: sandboxes, Background: func() int { return 0 },
		ChannelProbe:  func(context.Context) (time.Time, error) { return time.Now().UTC(), nil },
		ManagerSHA256: managerSHA, Architecture: "amd64", PollInterval: time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	return value, runtimeGate
}
