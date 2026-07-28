package migration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/driver"
)

type retirementDockerResourceState struct {
	id          string
	labels      map[string]string
	attachments int
}

// retirementRunner models only the closed command vocabulary used by the
// source-retirement transaction. Unknown commands fail the test instead of
// silently making a destructive test pass.
type retirementRunner struct {
	calls     []string
	resources map[string]*retirementDockerResourceState
	removed   []string
}

func (r *retirementRunner) Run(_ context.Context, name string, args []string, _ []string) (driver.Result, error) {
	call := name + " " + strings.Join(args, " ")
	r.calls = append(r.calls, call)
	if name == "systemctl" {
		switch {
		case len(args) >= 2 && args[1] == "show":
			return driver.Result{Stdout: "enabled\n"}, nil
		case len(args) >= 2 && args[1] == "is-active":
			return driver.Result{ExitCode: 3}, errors.New("unit is inactive")
		case len(args) >= 2 && args[1] == "list-units":
			return driver.Result{}, nil
		case len(args) >= 2 && (args[1] == "disable" || args[1] == "daemon-reload"):
			return driver.Result{}, nil
		default:
			return driver.Result{}, fmt.Errorf("unexpected systemctl command: %s", call)
		}
	}
	if name != "docker" {
		return driver.Result{}, fmt.Errorf("unexpected command: %s", call)
	}
	if len(args) == 4 && args[0] == "ps" && args[1] == "-aq" && args[2] == "--filter" {
		// Committed fixtures contain no remaining legacy containers. Storage
		// ownership is exercised independently below.
		return driver.Result{}, nil
	}
	if len(args) == 5 && (args[0] == "network" || args[0] == "volume") && args[1] == "ls" {
		nameFilter := strings.TrimPrefix(args[4], "name=^")
		resourceName := strings.TrimSuffix(nameFilter, "$")
		resource := r.resources[args[0]+"/"+resourceName]
		if resource == nil {
			return driver.Result{}, nil
		}
		if args[0] == "volume" {
			return driver.Result{Stdout: resourceName + "\n"}, nil
		}
		return driver.Result{Stdout: resource.id + "\n"}, nil
	}
	if len(args) == 5 && (args[0] == "network" || args[0] == "volume") && args[1] == "inspect" {
		resourceName := args[4]
		resource := r.resources[args[0]+"/"+resourceName]
		if resource == nil {
			return driver.Result{ExitCode: 1}, errors.New("resource disappeared")
		}
		switch args[3] {
		case "{{json .Labels}}":
			data, err := json.Marshal(resource.labels)
			return driver.Result{Stdout: string(data)}, err
		case "{{len .Containers}}":
			return driver.Result{Stdout: fmt.Sprintf("%d\n", resource.attachments)}, nil
		default:
			return driver.Result{}, fmt.Errorf("unexpected inspect format: %s", call)
		}
	}
	if len(args) == 3 && (args[0] == "network" || args[0] == "volume") && args[1] == "rm" {
		key := args[0] + "/" + args[2]
		if r.resources[key] == nil {
			return driver.Result{ExitCode: 1}, errors.New("resource disappeared")
		}
		delete(r.resources, key)
		r.removed = append(r.removed, key)
		return driver.Result{}, nil
	}
	return driver.Result{}, fmt.Errorf("unexpected docker command: %s", call)
}

type retirementFixture struct {
	service           *Service
	runner            *retirementRunner
	plan              Plan
	base              string
	legacyRoot        string
	legacyData        string
	unitPath          string
	ordinaryBackup    string
	managerSentinel   string
	configRetireCalls int
}

func newRetirementFixture(t *testing.T) *retirementFixture {
	t.Helper()
	base := t.TempDir()
	legacyRoot := filepath.Join(base, "source-install", "checkout")
	legacyData := filepath.Join(legacyRoot, "data")
	writeRetirementFile(t, filepath.Join(legacyData, "platform.db"), "authoritative database")
	writeRetirementFile(t, filepath.Join(legacyData, "workspaces", "agent-1", "memory.txt"), "authoritative workspace")
	unitPath := filepath.Join(base, "source-config", "systemd", "user", "enterprise-agent-platform.service")
	writeRetirementFile(t, unitPath, "[Service]\nExecStart=/source/venv/bin/python\n")

	runner := &retirementRunner{resources: make(map[string]*retirementDockerResourceState)}
	currentRoot := filepath.Join(base, "current")
	fixture := &retirementFixture{
		runner:          runner,
		base:            base,
		legacyRoot:      legacyRoot,
		legacyData:      legacyData,
		unitPath:        unitPath,
		ordinaryBackup:  filepath.Join(currentRoot, "backups", "ordinary-update-snapshot", "sentinel"),
		managerSentinel: filepath.Join(currentRoot, "manager", "current-manager-state"),
	}
	service := &Service{
		StatePath:       filepath.Join(currentRoot, "manager", "migration.json"),
		DestinationData: filepath.Join(currentRoot, "data"),
		BackupRoot:      filepath.Join(currentRoot, "backups"),
		QuarantineRoot:  filepath.Join(currentRoot, "quarantine"),
		LegacyUnitPath:  unitPath,
		Runner:          runner,
		Now: func() time.Time {
			return time.Date(2026, time.July, 20, 12, 0, 0, 0, time.UTC)
		},
		RetirementReady: func(context.Context) (string, error) { return "generation-healthy", nil },
	}
	fixture.service = service
	service.RetireConfig = func() error {
		fixture.configRetireCalls++
		return nil
	}

	const sourceCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if _, err := service.Configure(legacyRoot, legacyData, "enterprise-agent-platform.service", sourceCommit); err != nil {
		t.Fatal(err)
	}
	if err := service.Cutover(context.Background(), "op-source-install"); err != nil {
		t.Fatal(err)
	}
	if err := service.FinalizeCleanup(context.Background(), "op-source-install"); err != nil {
		t.Fatal(err)
	}
	plan, err := service.Plan()
	if err != nil || plan.Status != "committed" || !plan.ArchiveReady {
		t.Fatalf("fixture did not reach a committed recovery boundary: %#v %v", plan, err)
	}
	fixture.plan = plan
	fixture.installResiduals(t)
	return fixture
}

func (f *retirementFixture) installResiduals(t *testing.T) {
	t.Helper()
	writeRetirementFile(t, filepath.Join(f.service.DestinationData, "auto-update-state.json"), "{}")
	writeRetirementFile(t, filepath.Join(f.service.DestinationData, "runtimes", "agent", "app", "legacy.py"), "legacy runtime")
	writeRetirementFile(t, filepath.Join(filepath.Dir(f.service.StatePath), "control", "retry-source-migration.sh"), "#!/bin/sh\n")
	writeRetirementFile(t, filepath.Join(filepath.Dir(f.service.StatePath), "control", ".install-source-migration.incoming"), "temporary")
	writeRetirementFile(t, filepath.Join(filepath.Dir(f.service.StatePath), "recovery", "ubitech-manager-"+strings.Repeat("b", 64)), "manager")
	writeRetirementFile(t, filepath.Join(filepath.Dir(f.service.StatePath), "recovery", "source-transition-migration.py"), "guard")
	writeRetirementFile(t, filepath.Join(filepath.Dir(f.service.StatePath), "recovery", ".ubitech-manager.incoming.123"), "incoming")
	writeRetirementFile(t, filepath.Join(filepath.Dir(f.unitPath), "ubitech-agent-migrate.service"), "[Service]\n")
	writeRetirementFile(t, filepath.Join(filepath.Dir(f.unitPath), "ubitech-agent-migrate.timer"), "[Timer]\n")
	writeRetirementFile(t, filepath.Join(filepath.Dir(f.unitPath), ".ubitech-agent-migrate.timer.old"), "temporary")
	writeRetirementFile(t, filepath.Join(f.service.QuarantineRoot, f.plan.OperationID, "source-entry"), "quarantined")
	writeRetirementFile(t, f.ordinaryBackup, "keep rollback state")
	writeRetirementFile(t, f.managerSentinel, "keep current manager state")

	wants := filepath.Join(filepath.Dir(f.unitPath), "default.target.wants")
	if err := os.MkdirAll(wants, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(f.unitPath, filepath.Join(wants, filepath.Base(f.unitPath))); err != nil {
		t.Fatal(err)
	}
	timerWants := filepath.Join(filepath.Dir(f.unitPath), "timers.target.wants")
	if err := os.MkdirAll(timerWants, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(filepath.Dir(f.unitPath), "ubitech-agent-migrate.timer"), filepath.Join(timerWants, "ubitech-agent-migrate.timer")); err != nil {
		t.Fatal(err)
	}
}

func (f *retirementFixture) addOwnedDockerStorage() {
	searxProject := legacyComposeTargets(f.plan.LegacyData)[1].Project
	resources := []struct {
		kind, name, project, logical, id string
	}{
		{"network", "firecrawl_backend", "firecrawl", "backend", strings.Repeat("1", 64)},
		{"volume", "firecrawl_fdb-data", "firecrawl", "fdb-data", ""},
		{"volume", "firecrawl_fdb-cluster-file", "firecrawl", "fdb-cluster-file", ""},
		{"network", searxProject + "_default", searxProject, "default", strings.Repeat("2", 64)},
	}
	for _, resource := range resources {
		f.runner.resources[resource.kind+"/"+resource.name] = &retirementDockerResourceState{
			id: resource.id,
			labels: map[string]string{
				"com.docker.compose.project":          resource.project,
				"com.docker.compose." + resource.kind: resource.logical,
			},
		}
	}
}

func writeRetirementFile(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestSourceRetirementPurgesOnlyAllowlistedLegacyArtifacts(t *testing.T) {
	fixture := newRetirementFixture(t)
	fixture.addOwnedDockerStorage()
	oldPaths := []string{fixture.plan.LegacyRoot, fixture.plan.LegacyData, fixture.plan.ArchivePath, fixture.plan.LegacyUnitPath}

	if err := fixture.service.Retire(context.Background()); err != nil {
		t.Fatal(err)
	}
	plan, err := fixture.service.Plan()
	if err != nil {
		t.Fatal(err)
	}
	if plan.Status != "purged" || plan.Retirement == nil || plan.Retirement.Status != "completed" ||
		!plan.Retirement.SystemdRemoved || !plan.Retirement.SourceStateRemoved ||
		!plan.Retirement.DockerRemoved || !plan.Retirement.RecoveryRemoved {
		t.Fatalf("retirement did not produce a complete tombstone: %#v", plan)
	}
	if fixture.configRetireCalls != 1 {
		t.Fatalf("legacy Manager configuration retired %d times", fixture.configRetireCalls)
	}
	raw, err := os.ReadFile(fixture.service.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	for _, oldPath := range oldPaths {
		if strings.Contains(string(raw), oldPath) {
			t.Fatalf("purged tombstone retained obsolete absolute path %q: %s", oldPath, raw)
		}
	}
	for path, want := range map[string]string{
		filepath.Join(fixture.service.DestinationData, "platform.db"):                         "authoritative database",
		filepath.Join(fixture.service.DestinationData, "workspaces", "agent-1", "memory.txt"): "authoritative workspace",
		fixture.ordinaryBackup:  "keep rollback state",
		fixture.managerSentinel: "keep current manager state",
	} {
		data, readErr := os.ReadFile(path)
		if readErr != nil || string(data) != want {
			t.Fatalf("authoritative/current sentinel changed at %s: %q %v", path, data, readErr)
		}
	}
	for _, path := range []string{
		fixture.plan.ArchivePath,
		fixture.unitPath,
		filepath.Join(fixture.service.DestinationData, "auto-update-state.json"),
		filepath.Join(fixture.service.DestinationData, "runtimes", "agent", "app"),
		filepath.Join(filepath.Dir(fixture.service.StatePath), "recovery"),
		filepath.Join(filepath.Dir(fixture.service.StatePath), "control", "retry-source-migration.sh"),
		filepath.Join(fixture.service.QuarantineRoot, fixture.plan.OperationID),
	} {
		if _, statErr := os.Lstat(path); !os.IsNotExist(statErr) {
			t.Fatalf("legacy artifact survived at %s: %v", path, statErr)
		}
	}
	if len(fixture.runner.removed) != 4 {
		t.Fatalf("expected four exact Compose resources to be removed, got %#v", fixture.runner.removed)
	}
}

func TestSourceRetirementNoopsOutsideCampaignEligibility(t *testing.T) {
	for _, test := range []struct {
		name string
		plan *Plan
	}{
		{name: "no plan"},
		{name: "noncommitted", plan: &Plan{SchemaVersion: 1, Status: "configured", CreatedAt: time.Date(2026, time.July, 20, 0, 0, 0, 0, time.UTC)}},
		{name: "post cutoff", plan: &Plan{SchemaVersion: 1, Status: "committed", ArchiveReady: true, CreatedAt: sourceRetirementCutoff}},
	} {
		t.Run(test.name, func(t *testing.T) {
			base := t.TempDir()
			runner := &retirementRunner{resources: make(map[string]*retirementDockerResourceState)}
			readyCalls, configCalls := 0, 0
			service := &Service{
				StatePath: filepath.Join(base, "manager", "migration.json"), Runner: runner,
				RetirementReady: func(context.Context) (string, error) { readyCalls++; return "generation", nil },
				RetireConfig:    func() error { configCalls++; return nil },
			}
			if test.plan != nil {
				if err := service.persistLocked(*test.plan); err != nil {
					t.Fatal(err)
				}
			}
			if err := service.Retire(context.Background()); err != nil {
				t.Fatalf("ineligible campaign returned an error: %v", err)
			}
			if readyCalls != 0 || configCalls != 0 || len(runner.calls) != 0 {
				t.Fatalf("ineligible campaign changed external state: ready=%d config=%d calls=%#v", readyCalls, configCalls, runner.calls)
			}
		})
	}
}

func TestSourceRetirementRejectsTamperedArchiveBeforeIntent(t *testing.T) {
	fixture := newRetirementFixture(t)
	archiveDatabase := filepath.Join(fixture.plan.ArchiveTrees[0].ArchivePath, "data", "platform.db")
	writeRetirementFile(t, archiveDatabase, "tampered")

	if err := fixture.service.Retire(context.Background()); err == nil || !strings.Contains(err.Error(), "verify source recovery pack before retirement intent") {
		t.Fatalf("tampered recovery pack was accepted: %v", err)
	}
	plan, err := fixture.service.Plan()
	if err != nil {
		t.Fatal(err)
	}
	if plan.Retirement != nil || plan.Status != "committed" || fixture.configRetireCalls != 0 {
		t.Fatalf("tamper failure crossed retirement intent: %#v config=%d", plan, fixture.configRetireCalls)
	}
	if _, err := os.Lstat(fixture.unitPath); err != nil {
		t.Fatalf("legacy unit changed before durable intent: %v", err)
	}
	if _, err := os.Lstat(fixture.plan.ArchivePath); err != nil {
		t.Fatalf("tampered recovery evidence was deleted: %v", err)
	}
}

func TestSourceRetirementPreservesChangedOrSymlinkedLegacyUnit(t *testing.T) {
	for _, mode := range []string{"changed", "symlink"} {
		t.Run(mode, func(t *testing.T) {
			fixture := newRetirementFixture(t)
			if err := os.Remove(fixture.unitPath); err != nil {
				t.Fatal(err)
			}
			var target string
			if mode == "changed" {
				writeRetirementFile(t, fixture.unitPath, "[Service]\nExecStart=/operator/replacement\n")
			} else {
				target = filepath.Join(fixture.base, "operator-owned.service")
				writeRetirementFile(t, target, "do not delete")
				if err := os.Symlink(target, fixture.unitPath); err != nil {
					t.Fatal(err)
				}
			}

			if err := fixture.service.Retire(context.Background()); err == nil || !strings.Contains(err.Error(), "legacy systemd unit changed after migration") {
				t.Fatalf("%s legacy unit was not rejected: %v", mode, err)
			}
			info, err := os.Lstat(fixture.unitPath)
			if err != nil {
				t.Fatalf("%s unit was deleted: %v", mode, err)
			}
			if mode == "symlink" {
				if info.Mode()&os.ModeSymlink == 0 {
					t.Fatal("replacement symlink changed type")
				}
				data, readErr := os.ReadFile(target)
				if readErr != nil || string(data) != "do not delete" {
					t.Fatalf("symlink target changed: %q %v", data, readErr)
				}
			}
			plan, _ := fixture.service.Plan()
			if plan.Retirement == nil || plan.Retirement.SystemdRemoved || fixture.configRetireCalls != 0 {
				t.Fatalf("unit collision crossed its checkpoint: %#v config=%d", plan, fixture.configRetireCalls)
			}
			if _, err := os.Lstat(fixture.plan.ArchivePath); err != nil {
				t.Fatalf("unit collision deleted the recovery pack: %v", err)
			}
		})
	}
}

func TestSourceRetirementRejectsDockerLabelCollision(t *testing.T) {
	fixture := newRetirementFixture(t)
	fixture.runner.resources["network/firecrawl_backend"] = &retirementDockerResourceState{
		id: strings.Repeat("3", 64),
		labels: map[string]string{
			"com.docker.compose.project": "operator-project",
			"com.docker.compose.network": "backend",
		},
	}

	if err := fixture.service.Retire(context.Background()); err == nil || !strings.Contains(err.Error(), "conflicting Compose ownership labels") {
		t.Fatalf("Docker label collision was accepted: %v", err)
	}
	if len(fixture.runner.removed) != 0 || fixture.runner.resources["network/firecrawl_backend"] == nil {
		t.Fatalf("colliding Docker resource was deleted: removed=%#v", fixture.runner.removed)
	}
	plan, _ := fixture.service.Plan()
	if plan.Retirement == nil || !plan.Retirement.SystemdRemoved || !plan.Retirement.SourceStateRemoved || plan.Retirement.DockerRemoved || plan.Status == "purged" {
		t.Fatalf("Docker collision crossed its result checkpoint: %#v", plan)
	}
	data, err := os.ReadFile(filepath.Join(fixture.service.DestinationData, "platform.db"))
	if err != nil || string(data) != "authoritative database" {
		t.Fatalf("Docker collision changed authoritative data: %q %v", data, err)
	}
}

func TestSourceRetirementRetriesAfterPostDeletionPersistFailure(t *testing.T) {
	fixture := newRetirementFixture(t)
	injected := false
	fixture.service.BeforePersist = func(plan Plan) error {
		if !injected && plan.Retirement != nil && plan.Retirement.Status == "systemd_removed" {
			injected = true
			return errors.New("injected persistence failure after systemd deletion")
		}
		return nil
	}

	if err := fixture.service.Retire(context.Background()); err == nil || !strings.Contains(err.Error(), "injected persistence failure") {
		t.Fatalf("expected post-deletion persistence failure, got %v", err)
	}
	if _, err := os.Lstat(fixture.unitPath); !os.IsNotExist(err) {
		t.Fatalf("fault did not occur after the destructive unit step: %v", err)
	}
	durable, err := fixture.service.Plan()
	if err != nil {
		t.Fatal(err)
	}
	if durable.Retirement == nil || durable.Retirement.Status != "prepared" || durable.Retirement.SystemdRemoved {
		t.Fatalf("failed result was incorrectly marked durable: %#v", durable)
	}

	fixture.service.BeforePersist = nil
	if err := fixture.service.Retire(context.Background()); err != nil {
		t.Fatalf("idempotent retirement retry failed: %v", err)
	}
	completed, err := fixture.service.Plan()
	if err != nil || completed.Status != "purged" || completed.Retirement == nil || completed.Retirement.Status != "completed" {
		t.Fatalf("retry did not converge to its tombstone: %#v %v", completed, err)
	}
	daemonReloads := 0
	for _, call := range fixture.runner.calls {
		if call == "systemctl --user daemon-reload" {
			daemonReloads++
		}
	}
	if daemonReloads != 2 {
		t.Fatalf("destructive step was not safely replayed, daemon reloads=%d calls=%#v", daemonReloads, fixture.runner.calls)
	}
	data, err := os.ReadFile(filepath.Join(fixture.service.DestinationData, "workspaces", "agent-1", "memory.txt"))
	if err != nil || string(data) != "authoritative workspace" {
		t.Fatalf("retry changed authoritative workspace data: %q %v", data, err)
	}
}
