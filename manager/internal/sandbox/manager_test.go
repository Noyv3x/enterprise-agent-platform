package sandbox

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/driver"
	"github.com/ubitech/agent-platform/manager/internal/release"
)

type sandboxEngine struct {
	mu          sync.Mutex
	ensured     []driver.SandboxSpec
	stopped     []string
	removed     []string
	containers  map[string]driver.SandboxSpec
	running     map[string]bool
	entered     chan struct{}
	release     chan struct{}
	enterOnce   sync.Once
	stopEntered chan struct{}
	stopRelease chan struct{}
	stopOnce    sync.Once
}

func (e *sandboxEngine) Preflight(context.Context) error                    { return nil }
func (e *sandboxEngine) Pull(context.Context, release.Manifest) error       { return nil }
func (e *sandboxEngine) Prepare(context.Context, release.Manifest) error    { return nil }
func (e *sandboxEngine) StopFixed(context.Context) error                    { return nil }
func (e *sandboxEngine) StartFixed(context.Context, release.Manifest) error { return nil }
func (e *sandboxEngine) Migrate(context.Context, release.Manifest) error    { return nil }
func (e *sandboxEngine) Probe(context.Context, release.Manifest) error      { return nil }
func (e *sandboxEngine) Logs(context.Context, string, int) (string, error)  { return "", nil }
func (e *sandboxEngine) EnsureSandbox(ctx context.Context, spec driver.SandboxSpec) error {
	_, err := e.EnsureSandboxWithResult(ctx, spec)
	return err
}
func (e *sandboxEngine) EnsureSandboxWithResult(_ context.Context, spec driver.SandboxSpec) (driver.SandboxEnsureResult, error) {
	if e.entered != nil {
		e.enterOnce.Do(func() { close(e.entered) })
		<-e.release
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.containers == nil {
		e.containers = map[string]driver.SandboxSpec{}
		e.running = map[string]bool{}
	}
	e.ensured = append(e.ensured, spec)
	_, exists := e.containers[spec.ContainerName]
	if e.running[spec.ContainerName] {
		return driver.SandboxEnsureResult{WasRunning: true}, nil
	}
	e.containers[spec.ContainerName] = spec
	e.running[spec.ContainerName] = true
	if exists {
		return driver.SandboxEnsureResult{Started: true}, nil
	}
	return driver.SandboxEnsureResult{Created: true, Started: true}, nil
}
func (e *sandboxEngine) StopSandbox(_ context.Context, name string) error {
	if e.stopEntered != nil {
		e.stopOnce.Do(func() { close(e.stopEntered) })
		<-e.stopRelease
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.stopped = append(e.stopped, name)
	if e.running != nil {
		e.running[name] = false
	}
	return nil
}
func (e *sandboxEngine) RemoveSandbox(_ context.Context, name string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.removed = append(e.removed, name)
	delete(e.containers, name)
	delete(e.running, name)
	return nil
}
func (e *sandboxEngine) SandboxRunning(_ context.Context, name string) (bool, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, exists := e.containers[name]; !exists {
		return false, errors.New("sandbox does not exist")
	}
	return e.running[name], nil
}
func (e *sandboxEngine) ExecArgs(driver.SandboxSpec, string, string, []string) (string, []string) {
	return "true", nil
}

func TestReapSerializesContainerStopWithANewCall(t *testing.T) {
	engine := &sandboxEngine{stopEntered: make(chan struct{}), stopRelease: make(chan struct{})}
	root := t.TempDir()
	manager, err := Open(engine, filepath.Join(root, "data"), filepath.Join(root, "manager", "sandboxes.json"), "sandbox@sha256:"+strings.Repeat("a", 64), "network", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Ensure(context.Background(), "private-1", "user-1", time.Unix(1, 0)); err != nil {
		t.Fatal(err)
	}
	reapDone := make(chan error, 1)
	go func() {
		_, reapErr := manager.Reap(context.Background(), time.Unix(3601, 0))
		reapDone <- reapErr
	}()
	<-engine.stopEntered

	ensureDone := make(chan error, 1)
	go func() {
		_, ensureErr := manager.Ensure(context.Background(), "private-1", "user-1", time.Unix(3601, 0))
		if ensureErr == nil {
			ensureErr = manager.BeginCall("private-1", time.Unix(3601, 0))
		}
		ensureDone <- ensureErr
	}()
	select {
	case err := <-ensureDone:
		t.Fatalf("new call crossed an in-progress idle stop: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	close(engine.stopRelease)
	if err := <-reapDone; err != nil {
		t.Fatal(err)
	}
	if err := <-ensureDone; err != nil {
		t.Fatal(err)
	}
	name := "ubitech-sandbox-" + stableHash("private-1")[:16]
	engine.mu.Lock()
	running := engine.running[name]
	engine.mu.Unlock()
	if !running {
		t.Fatal("new call did not restart the sandbox after serialized idle reap")
	}
	records := manager.Records()
	if len(records) != 1 || records[0].ActiveCalls != 1 || records[0].StoppedAt != nil {
		t.Fatalf("new call was not durably active after reap: %#v", records)
	}
}

func TestSandboxImageUpgradeWaitsForProcessesThenRecreates(t *testing.T) {
	engine := &sandboxEngine{}
	root := t.TempDir()
	oldImage := "registry/sandbox@sha256:" + strings.Repeat("a", 64)
	newImage := "registry/sandbox@sha256:" + strings.Repeat("b", 64)
	manager, err := Open(engine, filepath.Join(root, "data"), filepath.Join(root, "manager", "sandboxes.json"), oldImage, "network", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Ensure(context.Background(), "private-1", "user-1", time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := manager.BeginCall("private-1", time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := manager.EndCall("private-1", true, time.Now()); err != nil {
		t.Fatal(err)
	}
	manager.SetImage(newImage)
	busy, err := manager.Ensure(context.Background(), "private-1", "user-1", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if busy.Image != oldImage || len(engine.removed) != 0 {
		t.Fatalf("busy sandbox was replaced instead of deferred: %#v %#v", busy, engine.removed)
	}
	if err := manager.ProcessExited("private-1", time.Now()); err != nil {
		t.Fatal(err)
	}
	upgraded, err := manager.Ensure(context.Background(), "private-1", "user-1", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if upgraded.Image != newImage || len(engine.stopped) != 1 || len(engine.removed) != 1 {
		t.Fatalf("idle sandbox was not recreated at new digest: %#v stopped=%v removed=%v", upgraded, engine.stopped, engine.removed)
	}
	records := manager.Records()
	if len(records) != 1 || records[0].Image != newImage {
		t.Fatalf("registry did not commit upgraded digest: %#v", records)
	}
}

func TestEnsureRejectsWorkspaceRebindingBeforeFilesystemOrDocker(t *testing.T) {
	engine := &sandboxEngine{}
	root := t.TempDir()
	manager, err := Open(engine, filepath.Join(root, "data"), filepath.Join(root, "manager", "sandboxes.json"), "sandbox@sha256:"+strings.Repeat("a", 64), "network", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Ensure(context.Background(), "private-1", "user-1", time.Unix(1, 0)); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Ensure(context.Background(), "private-1", "user-2", time.Unix(2, 0)); err == nil || !strings.Contains(err.Error(), "already bound") {
		t.Fatalf("workspace rebinding was not rejected: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(root, "data", "workspaces", "user-2")); !os.IsNotExist(err) {
		t.Fatalf("rejected workspace created a directory: %v", err)
	}
	engine.mu.Lock()
	ensureCount := len(engine.ensured)
	engine.mu.Unlock()
	if ensureCount != 1 {
		t.Fatalf("rejected workspace reached Docker: %d ensures", ensureCount)
	}
	records := manager.Records()
	if len(records) != 1 || records[0].WorkspaceID != "user-1" {
		t.Fatalf("registry binding changed after rejection: %#v", records)
	}
}

func TestConcurrentFirstEnsureCannotRaceWorkspaceBinding(t *testing.T) {
	engine := &sandboxEngine{entered: make(chan struct{}), release: make(chan struct{})}
	root := t.TempDir()
	manager, err := Open(engine, filepath.Join(root, "data"), filepath.Join(root, "manager", "sandboxes.json"), "sandbox@sha256:"+strings.Repeat("a", 64), "network", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 2)
	go func() {
		_, ensureErr := manager.Ensure(context.Background(), "private-1", "user-1", time.Unix(1, 0))
		results <- ensureErr
	}()
	<-engine.entered
	go func() {
		_, ensureErr := manager.Ensure(context.Background(), "private-1", "user-2", time.Unix(2, 0))
		results <- ensureErr
	}()
	close(engine.release)
	first, second := <-results, <-results
	if (first == nil) == (second == nil) {
		t.Fatalf("expected exactly one successful binding, got %v and %v", first, second)
	}
	failure := first
	if failure == nil {
		failure = second
	}
	if !strings.Contains(failure.Error(), "already bound") {
		t.Fatalf("losing binding returned the wrong error: %v", failure)
	}
	engine.mu.Lock()
	ensureCount := len(engine.ensured)
	engine.mu.Unlock()
	if ensureCount != 1 {
		t.Fatalf("concurrent losing binding reached Docker: %d ensures", ensureCount)
	}
}

func TestEnsureRejectsSymlinkedBindRoots(t *testing.T) {
	tests := []struct {
		name  string
		setup func(t *testing.T, data, outside string)
	}{
		{name: "data root", setup: func(t *testing.T, data, outside string) {
			t.Helper()
			if err := os.Symlink(outside, data); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "workspaces parent", setup: func(t *testing.T, data, outside string) {
			t.Helper()
			if err := os.MkdirAll(data, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(outside, filepath.Join(data, "workspaces")); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "workspace leaf", setup: func(t *testing.T, data, outside string) {
			t.Helper()
			if err := os.MkdirAll(filepath.Join(data, "workspaces"), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(outside, filepath.Join(data, "workspaces", "user-1")); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "home leaf", setup: func(t *testing.T, data, outside string) {
			t.Helper()
			parent := filepath.Join(data, "agent-envs", stableHash("private-1"))
			if err := os.MkdirAll(parent, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(outside, filepath.Join(parent, "home")); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "environment leaf", setup: func(t *testing.T, data, outside string) {
			t.Helper()
			parent := filepath.Join(data, "agent-envs", stableHash("private-1"))
			if err := os.MkdirAll(parent, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(outside, filepath.Join(parent, "env")); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "attachment parent", setup: func(t *testing.T, data, outside string) {
			t.Helper()
			if err := os.MkdirAll(filepath.Join(data, "attachments"), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(outside, filepath.Join(data, "attachments", "private")); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "attachment leaf", setup: func(t *testing.T, data, outside string) {
			t.Helper()
			if err := os.MkdirAll(filepath.Join(data, "attachments", "private"), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(outside, filepath.Join(data, "attachments", "private", "1")); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			data, outside := filepath.Join(root, "data"), filepath.Join(root, "outside")
			if err := os.MkdirAll(outside, 0o700); err != nil {
				t.Fatal(err)
			}
			test.setup(t, data, outside)
			engine := &sandboxEngine{}
			manager, err := Open(engine, data, filepath.Join(root, "manager", "sandboxes.json"), "sandbox@sha256:"+strings.Repeat("a", 64), "network", time.Hour)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := manager.Ensure(context.Background(), "private-1", "user-1", time.Now()); err == nil {
				t.Fatal("symlinked bind root was accepted")
			}
			engine.mu.Lock()
			ensureCount := len(engine.ensured)
			engine.mu.Unlock()
			if ensureCount != 0 {
				t.Fatal("symlinked bind root reached Docker")
			}
		})
	}
}

func TestDirectoryOwnerValidationRejectsAnotherIdentity(t *testing.T) {
	path := t.TempDir()
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.Close(fd)
	if err := requireOwnedDirectoryFD(fd, os.Getuid()+1, os.Getgid()); err == nil || !strings.Contains(err.Error(), "not owned") {
		t.Fatalf("foreign deployment identity was accepted: %v", err)
	}
}

func TestEnsureRollsBackNewSandboxWhenRegistryPersistenceFails(t *testing.T) {
	engine := &sandboxEngine{}
	root := t.TempDir()
	statePath := filepath.Join(root, "manager", "sandboxes.json")
	manager, err := Open(engine, filepath.Join(root, "data"), statePath, "sandbox@sha256:"+strings.Repeat("a", 64), "network", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(statePath, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Ensure(context.Background(), "private-1", "user-1", time.Now()); err == nil || !strings.Contains(err.Error(), "persist sandbox registry") {
		t.Fatalf("registry persistence failure was not returned: %v", err)
	}
	if records := manager.Records(); len(records) != 0 {
		t.Fatalf("failed ensure remained in memory registry: %#v", records)
	}
	engine.mu.Lock()
	defer engine.mu.Unlock()
	if len(engine.stopped) != 1 || len(engine.removed) != 1 || len(engine.containers) != 0 {
		t.Fatalf("uncommitted container was not removed: stopped=%v removed=%v containers=%v", engine.stopped, engine.removed, engine.containers)
	}
}

func TestEnsureRestopsExistingSandboxWhenRegistryPersistenceFails(t *testing.T) {
	engine := &sandboxEngine{}
	root := t.TempDir()
	statePath := filepath.Join(root, "manager", "sandboxes.json")
	manager, err := Open(engine, filepath.Join(root, "data"), statePath, "sandbox@sha256:"+strings.Repeat("a", 64), "network", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	startedAt := time.Unix(1, 0)
	if _, err := manager.Ensure(context.Background(), "private-1", "user-1", startedAt); err != nil {
		t.Fatal(err)
	}
	if stopped, err := manager.Reap(context.Background(), startedAt.Add(2*time.Hour)); err != nil || len(stopped) != 1 {
		t.Fatalf("prepare stopped sandbox: stopped=%v err=%v", stopped, err)
	}
	if err := os.Remove(statePath); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(statePath, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Ensure(context.Background(), "private-1", "user-1", startedAt.Add(3*time.Hour)); err == nil {
		t.Fatal("registry persistence failure was not returned")
	}
	records := manager.Records()
	if len(records) != 1 || records[0].StoppedAt == nil {
		t.Fatalf("previous stopped registry state was not restored: %#v", records)
	}
	engine.mu.Lock()
	defer engine.mu.Unlock()
	if engine.running[records[0].ContainerName] || len(engine.removed) != 0 || len(engine.stopped) != 2 {
		t.Fatalf("existing container was not returned to stopped state: running=%v stopped=%v removed=%v", engine.running, engine.stopped, engine.removed)
	}
}

func TestEnsureRestoresPreviousImageWhenRegistryPersistenceFails(t *testing.T) {
	engine := &sandboxEngine{}
	root := t.TempDir()
	statePath := filepath.Join(root, "manager", "sandboxes.json")
	oldImage := "sandbox@sha256:" + strings.Repeat("a", 64)
	newImage := "sandbox@sha256:" + strings.Repeat("b", 64)
	manager, err := Open(engine, filepath.Join(root, "data"), statePath, oldImage, "network", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Ensure(context.Background(), "private-1", "user-1", time.Unix(1, 0)); err != nil {
		t.Fatal(err)
	}
	manager.SetImage(newImage)
	if err := os.Remove(statePath); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(statePath, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Ensure(context.Background(), "private-1", "user-1", time.Unix(2, 0)); err == nil {
		t.Fatal("registry persistence failure was not returned")
	}
	records := manager.Records()
	if len(records) != 1 || records[0].Image != oldImage {
		t.Fatalf("previous image registry state was not restored: %#v", records)
	}
	engine.mu.Lock()
	defer engine.mu.Unlock()
	spec, exists := engine.containers[records[0].ContainerName]
	if !exists || !engine.running[records[0].ContainerName] || spec.Image != oldImage {
		t.Fatalf("previous image container was not restored: exists=%v running=%v spec=%#v", exists, engine.running, spec)
	}
}

func TestOpenRejectsCorruptSandboxIdentityRegistry(t *testing.T) {
	id := "private-1"
	hash := stableHash(id)
	valid := Record{SandboxID: id, SandboxHash: hash, WorkspaceID: "user-1", ContainerName: "ubitech-sandbox-" + hash[:16], Image: "sandbox@sha256:" + strings.Repeat("a", 64)}
	tests := []struct {
		name   string
		key    string
		mutate func(*Record)
	}{
		{name: "map key", key: "private-2", mutate: func(*Record) {}},
		{name: "hash", key: id, mutate: func(record *Record) { record.SandboxHash = strings.Repeat("0", 64) }},
		{name: "container", key: id, mutate: func(record *Record) { record.ContainerName = "other" }},
		{name: "workspace", key: id, mutate: func(record *Record) { record.WorkspaceID = "../outside" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			record := valid
			test.mutate(&record)
			root := t.TempDir()
			statePath := filepath.Join(root, "sandboxes.json")
			contents, err := json.Marshal(registry{SchemaVersion: 1, Records: map[string]Record{test.key: record}})
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(statePath, contents, 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := Open(&sandboxEngine{}, filepath.Join(root, "data"), statePath, valid.Image, "network", time.Hour); err == nil {
				t.Fatal("corrupt sandbox registry was accepted")
			}
		})
	}
}
