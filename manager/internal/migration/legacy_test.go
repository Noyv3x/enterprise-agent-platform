package migration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/driver"
)

type fakeRunner struct {
	calls     []string
	failMatch string
	unitState string
}

type composeCleanupRunner struct {
	fakeRunner
	containers map[string][]string
	labels     map[string]map[string]string
	removeErr  map[string]error
	removed    []string
}

func (r *composeCleanupRunner) Run(ctx context.Context, name string, args []string, env []string) (driver.Result, error) {
	call := name + " " + strings.Join(args, " ")
	r.calls = append(r.calls, call)
	if name == "docker" && len(args) >= 4 && args[0] == "ps" {
		project := strings.TrimPrefix(args[len(args)-1], "label=com.docker.compose.project=")
		return driver.Result{Stdout: strings.Join(r.containers[project], "\n")}, nil
	}
	if name == "docker" && len(args) == 4 && args[0] == "inspect" {
		labels, ok := r.labels[args[3]]
		if !ok {
			return driver.Result{}, errors.New("container disappeared during inspection")
		}
		data, err := json.Marshal(labels)
		return driver.Result{Stdout: string(data)}, err
	}
	if name == "docker" && len(args) == 3 && args[0] == "rm" {
		id := args[2]
		if err := r.removeErr[id]; err != nil {
			return driver.Result{}, err
		}
		r.removed = append(r.removed, id)
		return driver.Result{}, nil
	}
	// Avoid recording fallback calls twice: fakeRunner.Run records them itself.
	r.calls = r.calls[:len(r.calls)-1]
	return r.fakeRunner.Run(ctx, name, args, env)
}

func (r *fakeRunner) Run(_ context.Context, name string, args []string, _ []string) (driver.Result, error) {
	call := name + " " + strings.Join(args, " ")
	r.calls = append(r.calls, call)
	if r.failMatch != "" && strings.Contains(call, r.failMatch) {
		return driver.Result{}, os.ErrPermission
	}
	if strings.Contains(call, "--property=UnitFileState") {
		state := r.unitState
		if state == "" {
			state = "enabled"
		}
		return driver.Result{Stdout: state + "\n"}, nil
	}
	return driver.Result{}, nil
}

func TestCorruptLegacyPlanFailsClosedWithoutBeingOverwritten(t *testing.T) {
	root := filepath.Join(t.TempDir(), "checkout")
	source := filepath.Join(root, "data")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	statePath := filepath.Join(base, "manager", "migration.json")
	if err := os.MkdirAll(filepath.Dir(statePath), 0o700); err != nil {
		t.Fatal(err)
	}
	corrupt := []byte("{not-json\n")
	if err := os.WriteFile(statePath, corrupt, 0o600); err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{}
	service := &Service{StatePath: statePath, DestinationData: filepath.Join(base, "data"), BackupRoot: filepath.Join(base, "backups"), QuarantineRoot: filepath.Join(base, "quarantine"), Runner: runner}
	if !service.Active() {
		t.Fatal("an unreadable durable migration plan was treated as a fresh install")
	}
	if _, err := service.Configure(root, source); err == nil || !strings.Contains(err.Error(), "read existing legacy migration") {
		t.Fatalf("configure did not fail closed on corrupt state: %v", err)
	}
	for name, action := range map[string]func() error{
		"cutover":  func() error { return service.Cutover(context.Background(), "op") },
		"commit":   func() error { return service.FinalizeCleanup(context.Background(), "op") },
		"rollback": func() error { return service.Rollback(context.Background(), "op") },
	} {
		if err := action(); err == nil || !strings.Contains(err.Error(), "read legacy migration") {
			t.Fatalf("%s did not preserve the corrupt recovery boundary: %v", name, err)
		}
	}
	actual, err := os.ReadFile(statePath)
	if err != nil || string(actual) != string(corrupt) {
		t.Fatalf("corrupt state was overwritten: %q, %v", actual, err)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("external state changed after corrupt journal detection: %#v", runner.calls)
	}
}

func TestLegacyPrunePreservesUnknownAndOrdinaryRecoveryData(t *testing.T) {
	root := t.TempDir()
	backups := filepath.Join(root, "backups")
	quarantine := filepath.Join(root, "quarantine")
	keep := filepath.Join(backups, "op_keep")
	legacy := filepath.Join(backups, "op_drop-legacy")
	quarantined := filepath.Join(quarantine, "old-entry")
	for _, path := range []string{keep, legacy, quarantined} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
		old := time.Unix(1, 0)
		if err := os.Chtimes(path, old, old); err != nil {
			t.Fatal(err)
		}
	}
	service := &Service{StatePath: filepath.Join(root, "missing-migration.json"), BackupRoot: backups, QuarantineRoot: quarantine}
	if err := service.Prune(time.Unix(10_000, 0), time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatalf("ordinary rollback snapshot was pruned: %v", err)
	}
	for _, path := range []string{legacy, quarantined} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("unknown recovery data was pruned at %s: %v", path, err)
		}
	}
}

func TestLegacyPruneRequiresCommittedAndReverifiedRecoveryPack(t *testing.T) {
	for _, corrupt := range []bool{false, true} {
		t.Run(map[bool]string{false: "verified", true: "corrupt"}[corrupt], func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "checkout")
			source := filepath.Join(root, "data")
			if err := os.MkdirAll(source, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(source, "platform.db"), []byte("database"), 0o600); err != nil {
				t.Fatal(err)
			}
			base := t.TempDir()
			service := &Service{StatePath: filepath.Join(base, "manager", "migration.json"), DestinationData: filepath.Join(base, "data"), BackupRoot: filepath.Join(base, "backups"), QuarantineRoot: filepath.Join(base, "quarantine"), Runner: &fakeRunner{}}
			if _, err := service.Configure(root, source); err != nil {
				t.Fatal(err)
			}
			if err := service.Cutover(context.Background(), "op-prune"); err != nil {
				t.Fatal(err)
			}
			if err := service.FinalizeCleanup(context.Background(), "op-prune"); err != nil {
				t.Fatal(err)
			}
			plan, _ := service.Plan()
			if corrupt {
				if err := os.WriteFile(filepath.Join(plan.ArchivePath, "archive-receipt.json"), []byte("{}\n"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			old := time.Unix(1, 0)
			if err := os.Chtimes(plan.ArchivePath, old, old); err != nil {
				t.Fatal(err)
			}
			err := service.Prune(time.Unix(10_000, 0), time.Hour)
			if corrupt {
				if err == nil {
					t.Fatal("corrupt recovery pack was accepted for prune")
				}
				if _, statErr := os.Stat(plan.ArchivePath); statErr != nil {
					t.Fatalf("corrupt recovery pack was deleted: %v", statErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, statErr := os.Stat(plan.ArchivePath); !os.IsNotExist(statErr) {
				t.Fatalf("verified expired recovery pack remains: %v", statErr)
			}
		})
	}
}

func TestConfigureRejectsOverlappingLegacyAndDestinationData(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "checkout")
	legacy := filepath.Join(base, "legacy-data")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(legacy, 0o700); err != nil {
		t.Fatal(err)
	}
	for name, destination := range map[string]string{
		"destination-inside-legacy": filepath.Join(legacy, "new-data"),
		"legacy-inside-destination": base,
	} {
		t.Run(name, func(t *testing.T) {
			service := &Service{StatePath: filepath.Join(t.TempDir(), "migration.json"), DestinationData: destination, BackupRoot: t.TempDir()}
			if _, err := service.Configure(root, legacy); err == nil || !strings.Contains(err.Error(), "must not overlap") {
				t.Fatalf("overlapping roots were accepted: %v", err)
			}
		})
	}
}

func TestConfigureRejectsLegacyCheckoutInsideDestinationData(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "data", "old-checkout")
	legacy := filepath.Join(t.TempDir(), "external-legacy-data")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(legacy, 0o700); err != nil {
		t.Fatal(err)
	}
	service := &Service{
		StatePath:       filepath.Join(t.TempDir(), "migration.json"),
		DestinationData: filepath.Join(base, "data"),
		BackupRoot:      filepath.Join(base, "backups"),
	}
	if _, err := service.Configure(root, legacy); err == nil || !strings.Contains(err.Error(), "source root must not overlap") {
		t.Fatalf("checkout nested in destination data was accepted: %v", err)
	}
}

func TestPreCutoverCheckRunsWithoutChangingLegacyState(t *testing.T) {
	root := filepath.Join(t.TempDir(), "checkout")
	source := filepath.Join(root, "data")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	runner := &fakeRunner{}
	checks := 0
	service := &Service{
		StatePath: filepath.Join(base, "manager", "migration.json"), DestinationData: filepath.Join(base, "data"), BackupRoot: filepath.Join(base, "backups"), Runner: runner,
		PreCutoverCheck: func(context.Context, Plan) error {
			checks++
			return errors.New("stale bridge configuration")
		},
	}
	if _, err := service.Configure(root, source); err != nil {
		t.Fatal(err)
	}
	if err := service.PreCutover(context.Background(), "op-preflight"); err == nil || !strings.Contains(err.Error(), "stale bridge configuration") {
		t.Fatalf("expected final preflight rejection, got %v", err)
	}
	plan, err := service.Plan()
	if err != nil || plan.Status != "configured" || plan.OperationID != "" || checks != 1 || len(runner.calls) != 0 {
		t.Fatalf("preflight mutated legacy state: plan=%#v checks=%d calls=%v err=%v", plan, checks, runner.calls, err)
	}
}

func TestLegacyCutoverCopiesVerifiesAndCommits(t *testing.T) {
	root := filepath.Join(t.TempDir(), "checkout")
	source := filepath.Join(root, "enterprise-agent-platform", "data")
	if err := os.MkdirAll(filepath.Join(source, "workspaces", "user-1"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "platform.db"), []byte("database"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "workspaces", "user-1", "note.txt"), []byte("note"), 0o640); err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	if err := os.MkdirAll(filepath.Join(base, "data", "runtimes", "searxng", "config"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(base, "data", "runtimes", "searxng", "config", "settings.yml"), []byte("scaffold"), 0o600); err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{}
	service := &Service{StatePath: filepath.Join(base, "manager", "migration.json"), DestinationData: filepath.Join(base, "data"), BackupRoot: filepath.Join(base, "backups"), QuarantineRoot: filepath.Join(base, "quarantine"), Runner: runner}
	plan, err := service.Configure(root, source)
	if err != nil {
		t.Fatal(err)
	}
	if again, err := service.Configure(root, source); err != nil || again.ID != plan.ID {
		t.Fatalf("configure was not idempotent: %#v %v", again, err)
	}
	if err := service.Cutover(context.Background(), "op_test"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(base, "data", "workspaces", "user-1", "note.txt"))
	if err != nil || string(data) != "note" {
		t.Fatalf("migrated data mismatch: %q %v", data, err)
	}
	if err := service.FinalizeCleanup(context.Background(), "op_test"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("legacy checkout remains: %v", err)
	}
	final, err := service.Plan()
	if err != nil || final.Status != "committed" {
		t.Fatalf("unexpected plan: %#v %v", final, err)
	}
	if len(runner.calls) < 4 {
		t.Fatalf("expected service stop, git scan and timer cleanup: %#v", runner.calls)
	}
	if !strings.Contains(runner.calls[1], "disable --now enterprise-agent-platform.service") {
		t.Fatalf("legacy service was not durably disabled before cleanup: %#v", runner.calls)
	}
}

func TestPlanAndActiveRemainAvailableWhileCutoverCopies(t *testing.T) {
	root := filepath.Join(t.TempDir(), "checkout")
	source := filepath.Join(root, "data")
	if err := os.MkdirAll(filepath.Join(source, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "nested", "data.txt"), []byte("copy me"), 0o600); err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	service := &Service{
		StatePath:       filepath.Join(base, "manager", "migration.json"),
		DestinationData: filepath.Join(base, "data"),
		BackupRoot:      filepath.Join(base, "backups"),
		QuarantineRoot:  filepath.Join(base, "quarantine"),
		Runner:          &fakeRunner{},
	}
	if _, err := service.Configure(root, source); err != nil {
		t.Fatal(err)
	}

	copyStarted := make(chan struct{})
	releaseCopy := make(chan struct{})
	var blockOnce sync.Once
	service.SyncDir = func(path string) error {
		shouldBlock := false
		blockOnce.Do(func() {
			shouldBlock = true
			close(copyStarted)
		})
		if shouldBlock {
			<-releaseCopy
		}
		return syncDirectory(path)
	}
	defer func() {
		select {
		case <-releaseCopy:
		default:
			close(releaseCopy)
		}
	}()

	cutoverDone := make(chan error, 1)
	go func() { cutoverDone <- service.Cutover(context.Background(), "op-concurrent-plan") }()
	select {
	case <-copyStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("cutover did not reach the blocked copy durability step")
	}

	type planResult struct {
		plan Plan
		err  error
	}
	planDone := make(chan planResult, 1)
	go func() {
		plan, err := service.Plan()
		planDone <- planResult{plan: plan, err: err}
	}()
	select {
	case result := <-planDone:
		if result.err != nil || result.plan.Status != "copying" {
			t.Fatalf("read returned the wrong durable copy state: %#v %v", result.plan, result.err)
		}
		if len(result.plan.ComposeProjects) == 0 {
			t.Fatal("configured plan did not contain the expected compose snapshot")
		}
		original := result.plan.ComposeProjects[0]
		result.plan.ComposeProjects[0] = "caller mutation"
		again, err := service.Plan()
		if err != nil || again.ComposeProjects[0] != original {
			t.Fatalf("caller mutated the published plan snapshot: %#v %v", again, err)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("Plan waited for the long-running migration mutation")
	}

	activeDone := make(chan bool, 1)
	go func() { activeDone <- service.Active() }()
	select {
	case active := <-activeDone:
		if !active {
			t.Fatal("copying migration was reported inactive")
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("Active waited for the long-running migration mutation")
	}

	close(releaseCopy)
	select {
	case err := <-cutoverDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cutover did not resume after the copy barrier was released")
	}
}

func TestCleanupFailureIsRetryableButNeverReactivatesLegacyGate(t *testing.T) {
	root := filepath.Join(t.TempDir(), "checkout")
	source := filepath.Join(root, "data")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "platform.db"), []byte("database"), 0o600); err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	runner := &fakeRunner{}
	service := &Service{StatePath: filepath.Join(base, "manager", "migration.json"), DestinationData: filepath.Join(base, "data"), BackupRoot: filepath.Join(base, "backups"), QuarantineRoot: filepath.Join(base, "quarantine"), Runner: runner}
	if _, err := service.Configure(root, source); err != nil {
		t.Fatal(err)
	}
	if err := service.Cutover(context.Background(), "op_cleanup"); err != nil {
		t.Fatal(err)
	}
	runner.failMatch = "disable --now"
	if err := service.FinalizeCleanup(context.Background(), "op_cleanup"); err == nil {
		t.Fatal("expected injected legacy disable failure")
	}
	plan, err := service.Plan()
	if err != nil {
		t.Fatal(err)
	}
	if plan.Status != "cleanup_pending" || service.Active() {
		t.Fatalf("cleanup failure incorrectly reactivated migration: %#v", plan)
	}
	if _, err := os.Stat(root); err != nil {
		t.Fatalf("destructive cleanup ran before service disable: %v", err)
	}
	runner.failMatch = ""
	if err := service.FinalizeCleanup(context.Background(), "op_cleanup"); err != nil {
		t.Fatal(err)
	}
	plan, _ = service.Plan()
	if plan.Status != "committed" || service.Active() {
		t.Fatalf("cleanup retry did not commit: %#v", plan)
	}
}

func TestLegacyComposeContainerValidationAcceptsOnlyExactRuntimeOwnership(t *testing.T) {
	data := filepath.Join(t.TempDir(), "legacy-data")
	targets := legacyComposeTargets(data)
	if len(targets) != 2 {
		t.Fatalf("unexpected cleanup targets: %#v", targets)
	}
	firecrawl := targets[0]
	valid := map[string]string{
		"com.docker.compose.project":             firecrawl.Project,
		"com.docker.compose.service":             "api",
		"com.docker.compose.project.working_dir": filepath.Join(firecrawl.RuntimeRoot, "source", strings.Repeat("a", 40)),
	}
	if err := validateLegacyComposeContainer(firecrawl, valid); err != nil {
		t.Fatalf("safe unlabeled bridge container was rejected: %v", err)
	}
	withManagedLabel := cloneLabels(valid)
	withManagedLabel["org.ubitech.agent.managed"] = "true"
	if err := validateLegacyComposeContainer(firecrawl, withManagedLabel); err != nil {
		t.Fatalf("safe labelled bridge container was rejected: %v", err)
	}

	for name, mutate := range map[string]func(map[string]string){
		"different-project": func(labels map[string]string) {
			labels["com.docker.compose.project"] = "collision"
		},
		"unknown-service": func(labels map[string]string) {
			labels["com.docker.compose.service"] = "operator-container"
		},
		"relative-working-directory": func(labels map[string]string) {
			labels["com.docker.compose.project.working_dir"] = "runtimes/firecrawl"
		},
		"escaped-working-directory": func(labels map[string]string) {
			labels["com.docker.compose.project.working_dir"] = filepath.Join(data, "runtimes", "unrelated")
		},
		"conflicting-ownership-label": func(labels map[string]string) {
			labels["org.ubitech.agent.managed"] = "false"
		},
	} {
		t.Run(name, func(t *testing.T) {
			labels := cloneLabels(valid)
			mutate(labels)
			if err := validateLegacyComposeContainer(firecrawl, labels); err == nil {
				t.Fatalf("unsafe Compose metadata was accepted: %#v", labels)
			}
		})
	}
}

func TestLegacyComposeCleanupFailureStaysPendingAndRetriesUnlabelledContainer(t *testing.T) {
	root := filepath.Join(t.TempDir(), "checkout")
	source := filepath.Join(root, "data")
	if err := os.MkdirAll(filepath.Join(source, "runtimes", "firecrawl", "source", strings.Repeat("a", 40)), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "platform.db"), []byte("database"), 0o600); err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	id := "0123456789abcdef0123456789abcdef"
	target := legacyComposeTargets(source)[0]
	runner := &composeCleanupRunner{
		containers: map[string][]string{target.Project: {id}},
		labels: map[string]map[string]string{
			id: {
				"com.docker.compose.project":             target.Project,
				"com.docker.compose.service":             "api",
				"com.docker.compose.project.working_dir": filepath.Join(base, "unrelated-runtime"),
			},
		},
		removeErr: map[string]error{},
	}
	service := &Service{
		StatePath:       filepath.Join(base, "manager", "migration.json"),
		DestinationData: filepath.Join(base, "data"),
		BackupRoot:      filepath.Join(base, "backups"),
		QuarantineRoot:  filepath.Join(base, "quarantine"),
		Runner:          runner,
	}
	if _, err := service.Configure(root, source); err != nil {
		t.Fatal(err)
	}
	if err := service.Cutover(context.Background(), "op-compose-cleanup"); err != nil {
		t.Fatal(err)
	}
	if err := service.FinalizeCleanup(context.Background(), "op-compose-cleanup"); err == nil {
		t.Fatal("out-of-bound Compose container did not fail cleanup")
	}
	plan, err := service.Plan()
	if err != nil {
		t.Fatal(err)
	}
	if plan.Status != "cleanup_pending" || !plan.ArchiveReady || len(plan.ComposeCleanupErrors) != 1 || len(runner.removed) != 0 {
		t.Fatalf("cleanup failure crossed the commit boundary: plan=%#v removed=%#v", plan, runner.removed)
	}

	// Old bridge releases did not carry org.ubitech.agent.managed. The exact
	// project, fixed service and legacy runtime working directory are sufficient
	// for a safe retry.
	runner.labels[id]["com.docker.compose.project.working_dir"] = filepath.Join(target.RuntimeRoot, "source", strings.Repeat("a", 40))
	if err := service.FinalizeCleanup(context.Background(), "op-compose-cleanup"); err != nil {
		t.Fatal(err)
	}
	plan, err = service.Plan()
	if err != nil || plan.Status != "committed" || len(plan.ComposeCleanupErrors) != 0 || plan.Error != "" {
		t.Fatalf("safe cleanup retry did not commit: %#v %v", plan, err)
	}
	if len(runner.removed) != 1 || runner.removed[0] != id {
		t.Fatalf("safe unlabeled container was not removed exactly once: %#v", runner.removed)
	}
}

func TestLegacyComposeCleanupRejectsUnknownProjectWithoutQueryingIt(t *testing.T) {
	data := filepath.Join(t.TempDir(), "legacy-data")
	projects := legacyComposeProjects(data)
	runner := &composeCleanupRunner{containers: map[string][]string{}, labels: map[string]map[string]string{}, removeErr: map[string]error{}}
	service := &Service{Runner: runner}
	plan := Plan{LegacyData: data, ComposeProjects: append(projects, "operator-project")}
	failures := service.cleanupLegacyCompose(context.Background(), plan)
	if len(failures) != 1 || !strings.Contains(failures[0], "outside the exact legacy Compose allowlist") {
		t.Fatalf("unknown project did not fail closed: %#v", failures)
	}
	for _, call := range runner.calls {
		if strings.Contains(call, "operator-project") {
			t.Fatalf("unknown project was queried or mutated: %s", call)
		}
	}
}

func cloneLabels(source map[string]string) map[string]string {
	result := make(map[string]string, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func TestRolledBackMigrationCanBeSafelyRearmed(t *testing.T) {
	root := filepath.Join(t.TempDir(), "checkout")
	source := filepath.Join(root, "data")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "platform.db"), []byte("important"), 0o600); err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	runner := &fakeRunner{}
	service := &Service{StatePath: filepath.Join(base, "manager", "migration.json"), DestinationData: filepath.Join(base, "data"), BackupRoot: filepath.Join(base, "backups"), QuarantineRoot: filepath.Join(base, "quarantine"), Runner: runner}
	if _, err := service.Configure(root, source); err != nil {
		t.Fatal(err)
	}
	if err := service.Cutover(context.Background(), "attempt-1"); err != nil {
		t.Fatal(err)
	}
	if err := service.Rollback(context.Background(), "attempt-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(base, "data")); !os.IsNotExist(err) {
		t.Fatalf("first copied destination was not removed: %v", err)
	}
	rearmed, err := service.Configure(root, source)
	if err != nil {
		t.Fatal(err)
	}
	if rearmed.Status != "configured" || !service.Active() || rearmed.Copied || rearmed.OldServiceStopped {
		t.Fatalf("rolled-back migration was not safely rearmed: %#v", rearmed)
	}
	data, err := os.ReadFile(filepath.Join(source, "platform.db"))
	if err != nil || string(data) != "important" {
		t.Fatalf("legacy source data changed across retry: %q %v", data, err)
	}
	if err := service.Cutover(context.Background(), "attempt-2"); err != nil {
		t.Fatal(err)
	}
	migrated, _ := os.ReadFile(filepath.Join(base, "data", "platform.db"))
	if string(migrated) != "important" {
		t.Fatalf("retry did not recopy legacy data: %q", migrated)
	}
}

func TestPostStopPersistFailureRestartsLegacyService(t *testing.T) {
	root := filepath.Join(t.TempDir(), "checkout")
	source := filepath.Join(root, "data")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "platform.db"), []byte("important"), 0o600); err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	runner := &fakeRunner{}
	service := &Service{StatePath: filepath.Join(base, "manager", "migration.json"), DestinationData: filepath.Join(base, "data"), BackupRoot: filepath.Join(base, "backups"), QuarantineRoot: filepath.Join(base, "quarantine"), Runner: runner}
	if _, err := service.Configure(root, source); err != nil {
		t.Fatal(err)
	}
	injected := false
	service.BeforePersist = func(plan Plan) error {
		if plan.OldServiceStopped && plan.Status == "copying" && !injected {
			injected = true
			return errors.New("injected post-stop fsync failure")
		}
		return nil
	}
	if err := service.Cutover(context.Background(), "op-persist-failure"); err == nil {
		t.Fatal("expected injected persistence failure")
	}
	calls := strings.Join(runner.calls, "\n")
	if !strings.Contains(calls, "systemctl --user disable --now enterprise-agent-platform.service") || !strings.Contains(calls, "systemctl --user enable --now enterprise-agent-platform.service") {
		t.Fatalf("post-stop persistence failure was not compensated: %s", calls)
	}
	plan, err := service.Plan()
	if err != nil || plan.Status != "rolled_back" || plan.OldServiceStopped {
		t.Fatalf("compensated migration state is unsafe: %#v %v", plan, err)
	}
}

func TestExpectedSourceCommitPersistsAcrossMigrationRecovery(t *testing.T) {
	root := filepath.Join(t.TempDir(), "checkout")
	source := filepath.Join(root, "data")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	expected := strings.Repeat("a", 40)
	service := &Service{StatePath: filepath.Join(base, "manager", "migration.json"), DestinationData: filepath.Join(base, "data"), BackupRoot: filepath.Join(base, "backups"), QuarantineRoot: filepath.Join(base, "quarantine"), Runner: &fakeRunner{}}
	plan, err := service.Configure(root, source, "enterprise-agent-platform.service", expected)
	if err != nil || plan.ExpectedSourceCommit != expected {
		t.Fatalf("expected source commit was not configured: %#v %v", plan, err)
	}
	reopened := &Service{StatePath: service.StatePath, DestinationData: service.DestinationData, BackupRoot: service.BackupRoot, QuarantineRoot: service.QuarantineRoot, Runner: &fakeRunner{}}
	durable, err := reopened.Plan()
	if err != nil || durable.ExpectedSourceCommit != expected {
		t.Fatalf("expected source commit did not survive restart: %#v %v", durable, err)
	}
	if _, err := reopened.Configure(root, source, "enterprise-agent-platform.service", strings.Repeat("b", 40)); err == nil {
		t.Fatal("migration accepted a changed expected source commit")
	}
}

func TestStopIntentRecoveryStartsLegacyWithoutResultFlag(t *testing.T) {
	root := filepath.Join(t.TempDir(), "checkout")
	source := filepath.Join(root, "data")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	runner := &fakeRunner{}
	service := &Service{StatePath: filepath.Join(base, "manager", "migration.json"), DestinationData: filepath.Join(base, "data"), BackupRoot: filepath.Join(base, "backups"), QuarantineRoot: filepath.Join(base, "quarantine"), Runner: runner}
	plan, err := service.Configure(root, source)
	if err != nil {
		t.Fatal(err)
	}
	// Fault injection: systemctl stop returned, but power failed before the
	// result bit could be persisted. Only the durable stop intent remains.
	plan.Status = "stopping_legacy"
	plan.OperationID = "op-stop-window"
	plan.OldServiceStopped = false
	if err := service.persistLocked(plan); err != nil {
		t.Fatal(err)
	}
	if err := service.Rollback(context.Background(), plan.OperationID); err != nil {
		t.Fatal(err)
	}
	if calls := strings.Join(runner.calls, "\n"); !strings.Contains(calls, "systemctl --user start enterprise-agent-platform.service") {
		t.Fatalf("stop intent recovery did not conservatively start legacy service: %s", calls)
	}
}

func TestEnabledDisableIntentRecoveryRestoresEnablementAfterRebootWindow(t *testing.T) {
	root := filepath.Join(t.TempDir(), "checkout")
	source := filepath.Join(root, "data")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	runner := &fakeRunner{unitState: "enabled"}
	service := &Service{StatePath: filepath.Join(base, "manager", "migration.json"), DestinationData: filepath.Join(base, "data"), BackupRoot: filepath.Join(base, "backups"), QuarantineRoot: filepath.Join(base, "quarantine"), Runner: runner}
	plan, err := service.Configure(root, source)
	if err != nil {
		t.Fatal(err)
	}
	// Exact reboot window: disable --now returned, but its result bit did not.
	plan.Status = "stopping_legacy"
	plan.OperationID = "op-enabled-disable-window"
	plan.UnitStateRecorded = true
	plan.LegacyUnitFileState = "enabled"
	plan.LegacyWasEnabled = true
	plan.OldServiceStopped = false
	if err := service.persistLocked(plan); err != nil {
		t.Fatal(err)
	}
	if err := service.Rollback(context.Background(), plan.OperationID); err != nil {
		t.Fatal(err)
	}
	if calls := strings.Join(runner.calls, "\n"); !strings.Contains(calls, "systemctl --user enable --now enterprise-agent-platform.service") {
		t.Fatalf("enabled unit semantics were not restored: %s", calls)
	}
}

func TestDisabledUnitCompensationStartsWithoutEnabling(t *testing.T) {
	root := filepath.Join(t.TempDir(), "checkout")
	source := filepath.Join(root, "data")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	runner := &fakeRunner{unitState: "disabled"}
	service := &Service{StatePath: filepath.Join(base, "manager", "migration.json"), DestinationData: filepath.Join(base, "data"), BackupRoot: filepath.Join(base, "backups"), QuarantineRoot: filepath.Join(base, "quarantine"), Runner: runner}
	if _, err := service.Configure(root, source); err != nil {
		t.Fatal(err)
	}
	injected := false
	service.BeforePersist = func(plan Plan) error {
		if plan.OldServiceStopped && !injected {
			injected = true
			return errors.New("injected post-disable persistence failure")
		}
		return nil
	}
	if err := service.Cutover(context.Background(), "op-disabled-compensation"); err == nil {
		t.Fatal("expected injected persistence failure")
	}
	calls := strings.Join(runner.calls, "\n")
	if !strings.Contains(calls, "systemctl --user start enterprise-agent-platform.service") || strings.Contains(calls, "systemctl --user enable --now enterprise-agent-platform.service") {
		t.Fatalf("disabled unit enablement semantics changed: %s", calls)
	}
}

func TestCopyTreeSyncsEveryDirectoryLeafToRoot(t *testing.T) {
	source := filepath.Join(t.TempDir(), "source")
	destination := filepath.Join(t.TempDir(), "staging")
	for _, directory := range []string{
		filepath.Join(source, "alpha", "one"),
		filepath.Join(source, "alpha", "two", "deep"),
	} {
		if err := os.MkdirAll(directory, 0o750); err != nil {
			t.Fatal(err)
		}
	}
	sourceFile := filepath.Join(source, "alpha", "one", "data.txt")
	if err := os.WriteFile(sourceFile, []byte("durable"), 0o764); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(sourceFile, 0o764); err != nil {
		t.Fatal(err)
	}
	synced := make([]string, 0)
	fileReadyBeforeDirectoryBarrier := false
	if _, err := copyTree(context.Background(), source, destination, func(path string) error {
		if samePath(path, filepath.Join(destination, "alpha", "one")) {
			copied := filepath.Join(path, "data.txt")
			content, err := os.ReadFile(copied)
			if err != nil || string(content) != "durable" {
				return fmt.Errorf("copied content was incomplete before directory sync: %q %w", content, err)
			}
			info, err := os.Stat(copied)
			if err != nil {
				return err
			}
			if info.Mode().Perm() != 0o764 {
				return fmt.Errorf("copied mode was incomplete before directory sync: %o", info.Mode().Perm())
			}
			fileReadyBeforeDirectoryBarrier = true
		}
		synced = append(synced, filepath.Clean(path))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if !fileReadyBeforeDirectoryBarrier {
		t.Fatal("copied file was not inspected before its parent directory barrier")
	}
	wantDirectories := []string{
		destination,
		filepath.Join(destination, "alpha"),
		filepath.Join(destination, "alpha", "one"),
		filepath.Join(destination, "alpha", "two"),
		filepath.Join(destination, "alpha", "two", "deep"),
	}
	positions := make(map[string]int, len(synced))
	for index, path := range synced {
		positions[path] = index
	}
	if len(synced) != len(wantDirectories) {
		t.Fatalf("unexpected synced directories: %#v", synced)
	}
	for _, directory := range wantDirectories {
		position, ok := positions[filepath.Clean(directory)]
		if !ok {
			t.Fatalf("directory was not synced: %s (all=%#v)", directory, synced)
		}
		if !samePath(directory, destination) {
			parent := filepath.Dir(directory)
			if parentPosition, parentOK := positions[parent]; parentOK && position >= parentPosition {
				t.Fatalf("child %s was not synced before parent %s: %#v", directory, parent, synced)
			}
		}
	}
	if !samePath(synced[len(synced)-1], destination) {
		t.Fatalf("staging root was not the final durability barrier: %#v", synced)
	}
}

func TestCopyTreeDirectorySyncFailureIsReturned(t *testing.T) {
	source := filepath.Join(t.TempDir(), "source")
	destination := filepath.Join(t.TempDir(), "staging")
	if err := os.MkdirAll(filepath.Join(source, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "nested", "data.txt"), []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}
	injected := errors.New("injected directory fsync failure")
	_, err := copyTree(context.Background(), source, destination, func(path string) error {
		if samePath(path, filepath.Join(destination, "nested")) {
			return injected
		}
		return nil
	})
	if !errors.Is(err, injected) || !strings.Contains(err.Error(), "sync copied directory") {
		t.Fatalf("directory fsync failure was not returned: %v", err)
	}
}

func TestDestinationParentSyncFailureNeverPersistsCopiedMigration(t *testing.T) {
	root := filepath.Join(t.TempDir(), "checkout")
	source := filepath.Join(root, "data")
	if err := os.MkdirAll(filepath.Join(source, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "nested", "data.txt"), []byte("important"), 0o600); err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	destination := filepath.Join(base, "data")
	runner := &fakeRunner{}
	service := &Service{
		StatePath:       filepath.Join(base, "manager", "migration.json"),
		DestinationData: destination,
		BackupRoot:      filepath.Join(base, "backups"),
		QuarantineRoot:  filepath.Join(base, "quarantine"),
		Runner:          runner,
	}
	if _, err := service.Configure(root, source); err != nil {
		t.Fatal(err)
	}
	injected := errors.New("injected destination parent fsync failure")
	service.SyncDir = func(path string) error {
		if samePath(path, filepath.Dir(destination)) {
			return injected
		}
		return syncDirectory(path)
	}
	if err := service.Cutover(context.Background(), "op-parent-sync"); !errors.Is(err, injected) {
		t.Fatalf("expected injected parent sync failure, got %v", err)
	}
	plan, err := service.Plan()
	if err != nil {
		t.Fatal(err)
	}
	if plan.Copied || plan.Status == "migrated" || plan.Status != "rolled_back" {
		t.Fatalf("unsynced destination was persisted as installed: %#v", plan)
	}
	if calls := strings.Join(runner.calls, "\n"); !strings.Contains(calls, "systemctl --user enable --now enterprise-agent-platform.service") {
		t.Fatalf("legacy service was not restored after the durability failure: %s", calls)
	}
	if content, readErr := os.ReadFile(filepath.Join(source, "nested", "data.txt")); readErr != nil || string(content) != "important" {
		t.Fatalf("authoritative legacy data was not recoverable: %q %v", content, readErr)
	}

	service.SyncDir = nil
	if _, err := service.Configure(root, source); err != nil {
		t.Fatalf("failed durability attempt could not be safely rearmed: %v", err)
	}
	if err := service.Cutover(context.Background(), "op-parent-sync-retry"); err != nil {
		t.Fatalf("rearmed migration did not complete: %v", err)
	}
}

func TestRenameBeforeCopiedPersistIsRemovedAndRetryable(t *testing.T) {
	root := filepath.Join(t.TempDir(), "checkout")
	source := filepath.Join(root, "data")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "platform.db"), []byte("important"), 0o600); err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	runner := &fakeRunner{}
	service := &Service{StatePath: filepath.Join(base, "manager", "migration.json"), DestinationData: filepath.Join(base, "data"), BackupRoot: filepath.Join(base, "backups"), QuarantineRoot: filepath.Join(base, "quarantine"), Runner: runner}
	if _, err := service.Configure(root, source); err != nil {
		t.Fatal(err)
	}
	cutoverPersistFailed := false
	service.BeforePersist = func(plan Plan) error {
		if plan.Copied && !plan.CopyPrepared {
			cutoverPersistFailed = true
		}
		if cutoverPersistFailed {
			return errors.New("injected power loss after destination rename")
		}
		return nil
	}
	if err := service.Cutover(context.Background(), "op-rename-window"); err == nil {
		t.Fatal("expected injected post-rename persistence failure")
	}
	durable, err := service.Plan()
	if err != nil || !durable.CopyPrepared || durable.Copied {
		t.Fatalf("prepared-copy boundary was not durable: %#v %v", durable, err)
	}
	if _, err := os.Stat(filepath.Join(base, "data", "platform.db")); err != nil {
		t.Fatalf("fault injection did not occur after rename: %v", err)
	}
	if calls := strings.Join(runner.calls, "\n"); !strings.Contains(calls, "systemctl --user enable --now enterprise-agent-platform.service") {
		t.Fatalf("post-rename state failure did not synchronously restore legacy service: %s", calls)
	}
	service.BeforePersist = nil
	if err := service.Rollback(context.Background(), "op-rename-window"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(base, "data")); !os.IsNotExist(err) {
		t.Fatalf("rollback retained an uncommitted renamed destination: %v", err)
	}
	if _, err := service.Configure(root, source); err != nil {
		t.Fatalf("rolled-back rename window could not be rearmed: %v", err)
	}
	if err := service.Cutover(context.Background(), "op-rename-retry"); err != nil {
		t.Fatalf("rearmed migration did not retry: %v", err)
	}
}

func TestRollbackRemovesLegacyRenameWindowWithoutResultFlags(t *testing.T) {
	root := filepath.Join(t.TempDir(), "checkout")
	source := filepath.Join(root, "data")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "platform.db"), []byte("authoritative"), 0o600); err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	runner := &fakeRunner{}
	service := &Service{StatePath: filepath.Join(base, "manager", "migration.json"), DestinationData: filepath.Join(base, "data"), BackupRoot: filepath.Join(base, "backups"), QuarantineRoot: filepath.Join(base, "quarantine"), Runner: runner}
	plan, err := service.Configure(root, source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(plan.DestinationData, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(plan.DestinationData, "platform.db"), []byte("uncommitted-copy"), 0o600); err != nil {
		t.Fatal(err)
	}
	// This is the exact old-protocol power window: rename completed, but neither
	// Entries nor either copy result flag reached stable storage.
	plan.Status = "copying"
	plan.OperationID = "op-old-rename-window"
	plan.OldServiceStopped = true
	plan.Copied = false
	plan.CopyPrepared = false
	plan.Entries = nil
	if err := service.persistLocked(plan); err != nil {
		t.Fatal(err)
	}
	if err := service.Rollback(context.Background(), plan.OperationID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(plan.DestinationData); !os.IsNotExist(err) {
		t.Fatalf("uncommitted destination without result flags survived rollback: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(source, "platform.db"))
	if err != nil || string(data) != "authoritative" {
		t.Fatalf("authoritative legacy data changed: %q %v", data, err)
	}
	if _, err := service.Configure(root, source); err != nil {
		t.Fatalf("old rename window could not be rearmed: %v", err)
	}
}

func TestCommitCreatesVerifiedRestorableLegacyArchive(t *testing.T) {
	root := filepath.Join(t.TempDir(), "checkout")
	source := filepath.Join(root, "data")
	if err := os.MkdirAll(filepath.Join(source, "workspaces", "agent-1"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte("SECRET=retained\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "workspaces", "agent-1", "note.txt"), []byte("recover me"), 0o640); err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	unit := filepath.Join(base, "config", "systemd", "user", "enterprise-agent-platform.service")
	if err := os.MkdirAll(filepath.Dir(unit), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(unit, []byte("[Service]\nExecStart=/legacy\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	service := &Service{StatePath: filepath.Join(base, "manager", "migration.json"), DestinationData: filepath.Join(base, "data"), BackupRoot: filepath.Join(base, "backups"), QuarantineRoot: filepath.Join(base, "quarantine"), LegacyUnitPath: unit, Runner: &fakeRunner{}}
	if _, err := service.Configure(root, source); err != nil {
		t.Fatal(err)
	}
	if err := service.Cutover(context.Background(), "op-restorable"); err != nil {
		t.Fatal(err)
	}
	if err := service.FinalizeCleanup(context.Background(), "op-restorable"); err != nil {
		t.Fatal(err)
	}
	plan, err := service.Plan()
	if err != nil || !plan.ArchiveReady || len(plan.ArchiveTrees) != 1 || len(plan.ArchiveFiles) != 1 {
		t.Fatalf("legacy recovery pack is incomplete: %#v %v", plan, err)
	}
	archived, err := os.ReadFile(filepath.Join(plan.ArchivePath, "checkout", "data", "workspaces", "agent-1", "note.txt"))
	if err != nil || string(archived) != "recover me" {
		t.Fatalf("checkout was not archived intact: %q %v", archived, err)
	}
	if err := os.Remove(unit); err != nil {
		t.Fatal(err)
	}
	if err := service.Restore(context.Background(), "op-restorable"); err != nil {
		t.Fatal(err)
	}
	restored, err := os.ReadFile(filepath.Join(root, "data", "workspaces", "agent-1", "note.txt"))
	if err != nil || string(restored) != "recover me" {
		t.Fatalf("checkout restore failed: %q %v", restored, err)
	}
	restoredUnit, err := os.ReadFile(unit)
	if err != nil || !strings.Contains(string(restoredUnit), "ExecStart=/legacy") {
		t.Fatalf("unit restore failed: %q %v", restoredUnit, err)
	}
}

func TestArchiveRenamePowerWindowRecoversIdempotently(t *testing.T) {
	root := filepath.Join(t.TempDir(), "checkout")
	source := filepath.Join(root, "data")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "platform.db"), []byte("database"), 0o600); err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	service := &Service{StatePath: filepath.Join(base, "manager", "migration.json"), DestinationData: filepath.Join(base, "data"), BackupRoot: filepath.Join(base, "backups"), QuarantineRoot: filepath.Join(base, "quarantine"), Runner: &fakeRunner{}}
	if _, err := service.Configure(root, source); err != nil {
		t.Fatal(err)
	}
	if err := service.Cutover(context.Background(), "op-archive-window"); err != nil {
		t.Fatal(err)
	}
	injected := false
	service.BeforeArchiveStep = func(step string) error {
		if step == "checkout:installed" && !injected {
			injected = true
			return errors.New("injected power loss after archive rename")
		}
		return nil
	}
	if err := service.FinalizeCleanup(context.Background(), "op-archive-window"); err == nil {
		t.Fatal("expected archive fault")
	}
	plan, _ := service.Plan()
	if plan.Status != "cleanup_pending" || plan.ArchiveReady {
		t.Fatalf("archive fault was falsely committed: %#v", plan)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("fault did not occur after checkout rename: %v", err)
	}
	if _, err := os.Stat(filepath.Join(plan.ArchivePath, "checkout", "data", "platform.db")); err != nil {
		t.Fatalf("renamed archive is unavailable for recovery: %v", err)
	}
	service.BeforeArchiveStep = nil
	if err := service.FinalizeCleanup(context.Background(), "op-archive-window"); err != nil {
		t.Fatalf("archive window did not recover: %v", err)
	}
	plan, _ = service.Plan()
	if plan.Status != "committed" || !plan.ArchiveReady {
		t.Fatalf("archive retry did not converge: %#v", plan)
	}
}

func TestCrossFilesystemArchiveCopiesVerifiesThenRemovesSource(t *testing.T) {
	root := filepath.Join(t.TempDir(), "checkout")
	source := filepath.Join(root, "data")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "platform.db"), []byte("database"), 0o600); err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	service := &Service{StatePath: filepath.Join(base, "manager", "migration.json"), DestinationData: filepath.Join(base, "data"), BackupRoot: filepath.Join(base, "backups"), QuarantineRoot: filepath.Join(base, "quarantine"), Runner: &fakeRunner{}, ArchiveRename: func(string, string) error { return syscall.EXDEV }}
	if _, err := service.Configure(root, source); err != nil {
		t.Fatal(err)
	}
	if err := service.Cutover(context.Background(), "op-cross-fs"); err != nil {
		t.Fatal(err)
	}
	if err := service.FinalizeCleanup(context.Background(), "op-cross-fs"); err != nil {
		t.Fatal(err)
	}
	plan, _ := service.Plan()
	data, err := os.ReadFile(filepath.Join(plan.ArchivePath, "checkout", "data", "platform.db"))
	if err != nil || string(data) != "database" {
		t.Fatalf("cross-filesystem archive mismatch: %q %v", data, err)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("source was removed before or not removed after verification: %v", err)
	}
}

func TestLegacyCacheRetirementUsesClosedWhitelist(t *testing.T) {
	root := filepath.Join(t.TempDir(), "checkout")
	source := filepath.Join(root, "data")
	files := map[string]string{
		"runtimes/cognee/source/repo.py":           "source",
		"runtimes/cognee/index/index.db":           "index",
		"runtimes/firecrawl/source/server.ts":      "source",
		"runtimes/firecrawl/session/state.json":    "session",
		"runtimes/camofox/app/server.js":           "app",
		"runtimes/camofox/browser/camoufox":        "browser",
		"runtimes/camofox/profiles/a/profile.json": "profile",
		"runtimes/camofox/cookies/a.json":          "cookie",
		"runtimes/camofox/traces/a.json":           "trace",
		"runtimes/node/current/bin/node":           "node",
	}
	for relative, content := range files {
		path := filepath.Join(source, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	base := t.TempDir()
	service := &Service{StatePath: filepath.Join(base, "manager", "migration.json"), DestinationData: filepath.Join(base, "data"), BackupRoot: filepath.Join(base, "backups"), QuarantineRoot: filepath.Join(base, "quarantine"), Runner: &fakeRunner{}}
	if _, err := service.Configure(root, source); err != nil {
		t.Fatal(err)
	}
	if err := service.Cutover(context.Background(), "op-cache-retire"); err != nil {
		t.Fatal(err)
	}
	if err := service.FinalizeCleanup(context.Background(), "op-cache-retire"); err != nil {
		t.Fatal(err)
	}
	for _, relative := range []string{"runtimes/cognee/source", "runtimes/firecrawl/source", "runtimes/camofox/app", "runtimes/camofox/browser", "runtimes/node"} {
		if _, err := os.Stat(filepath.Join(base, "data", filepath.FromSlash(relative))); !os.IsNotExist(err) {
			t.Fatalf("whitelisted cache survived at %s: %v", relative, err)
		}
	}
	for relative, expected := range map[string]string{
		"runtimes/cognee/index/index.db":           "index",
		"runtimes/firecrawl/session/state.json":    "session",
		"runtimes/camofox/profiles/a/profile.json": "profile",
		"runtimes/camofox/cookies/a.json":          "cookie",
		"runtimes/camofox/traces/a.json":           "trace",
	} {
		data, err := os.ReadFile(filepath.Join(base, "data", filepath.FromSlash(relative)))
		if err != nil || string(data) != expected {
			t.Fatalf("authoritative path was retired at %s: %q %v", relative, data, err)
		}
	}
	plan, _ := service.Plan()
	if len(plan.RetiredCaches) != 5 {
		t.Fatalf("unexpected retired-cache receipt: %#v", plan.RetiredCaches)
	}
}

func TestDisposablePathWhitelistNeverIncludesAuthoritativeRuntimeData(t *testing.T) {
	data := filepath.Join(t.TempDir(), "data")
	for _, candidate := range legacyDisposablePaths(data) {
		relative, err := filepath.Rel(data, candidate.Path)
		if err != nil || strings.Contains(relative, "profiles") || strings.Contains(relative, "cookies") || strings.Contains(relative, "traces") || strings.Contains(relative, "session") || strings.Contains(relative, "index") || strings.Contains(relative, "db") {
			t.Fatalf("unsafe disposable path: %#v %v", candidate, err)
		}
	}
}
