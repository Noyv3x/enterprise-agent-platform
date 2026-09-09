package executor

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
)

// The fake control command executes only this Go test binary, never a shell,
// container runtime, service, or user-supplied command.
func TestAccountingControlHelper(t *testing.T) {
	const prefix = "settlement-control="
	last := os.Args[len(os.Args)-1]
	if !strings.HasPrefix(last, prefix) {
		return
	}
	fmt.Print(strings.TrimPrefix(last, prefix))
	os.Exit(0)
}

type accountingEngine struct {
	engineStub
	binary      string
	mu          sync.Mutex
	statusCalls map[string]int
	watchGates  map[string]chan struct{}
	stops       int
}

func (e *accountingEngine) ExecArgs(_ driver.SandboxSpec, _, _ string, args []string) (string, []string) {
	status := "stopped"
	if args[1] == sandboxStatusScript {
		id := args[len(args)-1]
		e.mu.Lock()
		e.statusCalls[id]++
		initial := e.statusCalls[id] == 1
		gate := e.watchGates[id]
		e.mu.Unlock()
		if initial {
			status = "running"
		} else {
			<-gate
		}
	}
	return e.binary, []string{"-test.run=^TestAccountingControlHelper$", "--", "settlement-control=" + status}
}

func (e *accountingEngine) StopSandbox(context.Context, string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.stops++
	return nil
}

func TestRecoveredStopSettlesAccountingOnlyOnce(t *testing.T) {
	service, _ := newTestService(t)
	m := service.Processes
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	engine := &accountingEngine{binary: binary, statusCalls: map[string]int{}, watchGates: map[string]chan struct{}{"A": make(chan struct{}), "B": make(chan struct{})}}
	m.Engine = engine
	m.Sandboxes.Engine = engine
	spec, err := m.Sandboxes.Ensure(context.Background(), "private-1", "user-1", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"A", "B"} {
		state := persistedProcess{
			Snapshot:  ProcessSnapshot{ID: id, ScopeKey: "private:1", LifecycleID: "life-1", Target: "sandbox", Status: "running", Background: true, StartedAt: time.Now().UTC()},
			SandboxID: "private-1", WorkspaceID: "user-1", PIDFile: id,
		}
		path := filepath.Join(filepath.Dir(m.Sandboxes.StatePath), "processes", spec.AgentHash, id+".json")
		if err := atomicfile.WriteJSON(path, state, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	m.recoverSandboxProcesses()
	a, b := m.processes["A"], m.processes["B"]
	var releaseA sync.Once
	defer func() {
		releaseA.Do(func() { close(engine.watchGates["A"]) })
		close(engine.watchGates["B"])
		for _, p := range []*managedProcess{a, b} {
			select {
			case <-p.done:
			case <-time.After(15 * time.Second):
				t.Error("recovered watcher did not exit during fixture teardown")
			}
		}
	}()
	if records := m.Sandboxes.Records(); len(records) != 1 || records[0].BackgroundProcesses != 2 {
		t.Fatalf("recovery did not account for both running processes: %#v", records)
	}
	if !m.stopProcess(a) {
		t.Fatal("fake engine did not confirm A stopped")
	}
	releaseA.Do(func() { close(engine.watchGates["A"]) })
	select {
	case <-a.done:
	case <-time.After(15 * time.Second):
		t.Fatal("A watcher did not settle")
	}
	if status := m.snapshot(b).Status; status != "running" {
		t.Fatalf("B unexpectedly changed state: %s", status)
	}
	if records := m.Sandboxes.Records(); len(records) != 1 || records[0].BackgroundProcesses != 1 {
		t.Errorf("A stop plus watcher consumed B's accounting: %#v", records)
	}
	stopped, err := m.Sandboxes.Reap(context.Background(), time.Now().Add(2*m.Sandboxes.Idle))
	if err != nil {
		t.Fatal(err)
	}
	engine.mu.Lock()
	stopCalls := engine.stops
	engine.mu.Unlock()
	if len(stopped) != 0 || stopCalls != 0 {
		t.Errorf("reaper stopped sandbox while B remained running: stopped=%v engine stops=%d", stopped, stopCalls)
	}
}

func TestPruningRetainsUnsettledTerminalController(t *testing.T) {
	service, _ := newTestService(t)
	m := service.Processes
	m.maxCompletedRecords = 1
	m.completedRecordTTL = time.Hour
	now := time.Now().UTC()
	finished := now.Add(-2 * time.Hour)
	p := &managedProcess{
		snapshot: ProcessSnapshot{ID: "settling", ScopeKey: "private:1", LifecycleID: "life-1", Target: "sandbox", Status: "completed", StartedAt: finished, FinishedAt: &finished},
		done:     make(chan struct{}), stdout: &boundedBuffer{limit: 1024}, stderr: &boundedBuffer{limit: 1024},
	}
	defer close(p.done)
	m.processes["settling"] = p
	m.pruneCompleted(now)
	if _, err := m.Get("private:1", "life-1", "sandbox", "settling"); err != nil {
		t.Errorf("unsettled terminal controller disappeared from authoritative lookup: %v", err)
	}
	result, err := m.CleanupScopeWithEvidence("private:1", "life-1")
	if err == nil && result.Confirmed {
		t.Error("cleanup confirmed while the pruned terminal controller was still unsettled")
	}
}

func TestForegroundCleanupWaitsForEndCall(t *testing.T) {
	service, _ := newTestService(t)
	m := service.Processes
	if _, err := m.Sandboxes.Ensure(context.Background(), "private-1", "user-1", time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := m.Sandboxes.BeginCall("private-1", time.Now()); err != nil {
		t.Fatal(err)
	}
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(binary, "-test.run=^TestAccountingControlHelper$", "--", "settlement-control=")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	p := &managedProcess{
		snapshot: ProcessSnapshot{ID: "foreground", ScopeKey: "private:1", LifecycleID: "life-1", Target: "sandbox", Status: "running", StartedAt: time.Now().UTC()},
		command:  cmd, context: context.Background(), cancel: func() {}, sandboxID: "private-1", workspaceID: "user-1",
		done: make(chan struct{}), stdout: &boundedBuffer{limit: 1024}, stderr: &boundedBuffer{limit: 1024},
	}
	m.processes["foreground"] = p
	gate := &settlementGate{entered: make(chan struct{}), release: make(chan struct{})}
	m.Sandboxes.MaintenanceMu = gate
	go m.wait(p)
	select {
	case <-gate.entered:
	case <-time.After(15 * time.Second):
		t.Fatal("controller did not reach EndCall")
	}
	defer func() {
		close(gate.release)
		select {
		case <-p.done:
		case <-time.After(15 * time.Second):
			t.Fatal("foreground controller did not settle")
		}
		if records := m.Sandboxes.Records(); len(records) != 1 || records[0].ActiveCalls != 0 {
			t.Errorf("done did not include foreground accounting: %#v", records)
		}
		if !confirmStopped([]*managedProcess{p}, 40*time.Millisecond) {
			t.Error("settled foreground controller did not confirm cleanup")
		}
	}()
	if confirmStopped([]*managedProcess{p}, 40*time.Millisecond) {
		t.Fatal("controller confirmed before EndCall completed")
	}
	if records := m.Sandboxes.Records(); len(records) != 1 || records[0].ActiveCalls != 1 {
		t.Fatalf("foreground call ownership lost before settlement: %#v", records)
	}
}

type settlementGate struct {
	entered chan struct{}
	release chan struct{}
}

func (g *settlementGate) Lock()   { close(g.entered); <-g.release }
func (g *settlementGate) Unlock() {}
