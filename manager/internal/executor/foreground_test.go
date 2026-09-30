package executor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
)

func shellQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'" }

func TestForegroundTerminatesGrandchildren(t *testing.T) {
	for _, mode := range []string{"timeout", "cancel", "request-cancel", "leader-exit", "escaped-exit", "escaped-timeout"} {
		t.Run(mode, func(t *testing.T) {
			service, root := newTestService(t)
			marker := filepath.Join(root, "test-grandchild")
			command := "sleep 60 & child=$!; echo $child > " + shellQuote(marker) + "; wait"
			if mode == "leader-exit" {
				command = "sleep 60 & child=$!; echo $child > " + shellQuote(marker) + "; exit 0"
			}
			if strings.HasPrefix(mode, "escaped-") {
				command = "setsid sleep 60 & child=$!; echo $child > " + shellQuote(marker) + "; wait"
				if mode == "escaped-exit" {
					command = "setsid sleep 60 & child=$!; echo $child > " + shellQuote(marker) + "; sleep 0.1; exit 0"
				}
			}
			timeout := 5000
			if mode == "timeout" || mode == "escaped-timeout" {
				timeout = 250
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			bound := identity()
			bound.ExecutionContext.Profile = "chat"
			bound.ExecutionContext.WorkspaceID = "chat-user-1"
			type outcome struct {
				result ProcessSnapshot
				err    error
			}
			returned := make(chan outcome, 1)
			go func() {
				result, err := service.Processes.Run(ctx, Call{Identity: bound, Target: "sandbox"}, terminalArguments{Command: command, TimeoutMS: timeout})
				returned <- outcome{result, err}
			}()
			var pid int
			until := time.Now().Add(3 * time.Second)
			for time.Now().Before(until) {
				data, err := os.ReadFile(marker)
				if err == nil {
					pid, _ = strconv.Atoi(strings.TrimSpace(string(data)))
					if pid > 1 {
						break
					}
				}
				time.Sleep(5 * time.Millisecond)
			}
			if pid <= 1 {
				t.Fatal("grandchild did not start")
			}
			if mode == "cancel" {
				wrong := RunIdentity{RunID: bound.RunID, ScopeID: bound.ScopeID, LifecycleID: bound.LifecycleID, ExecutionContext: bound.ExecutionContext}
				wrong.ExecutionContext.Profile = "agent"
				if service.CancelRun(wrong) {
					t.Fatal("profile drift authorized cancellation")
				}
				wrong.ExecutionContext = bound.ExecutionContext
				wrong.ScopeID = "private:unrelated"
				if !service.CancelRun(wrong) {
					t.Fatal("unrelated empty run was not settled")
				}
				select {
				case result := <-returned:
					t.Fatalf("unrelated cancellation stopped command: %+v", result)
				default:
				}
				if _, err := os.Stat(fmt.Sprintf("/proc/%d", pid)); err != nil {
					t.Fatalf("grandchild was stopped by another identity: %v", err)
				}
				correct := RunIdentity{RunID: bound.RunID, ScopeID: bound.ScopeID, LifecycleID: bound.LifecycleID, ExecutionContext: bound.ExecutionContext}
				if !service.CancelRun(correct) {
					t.Fatal("run cancellation was not confirmed")
				}
			}
			if mode == "request-cancel" {
				cancel()
			}
			select {
			case got := <-returned:
				if got.err != nil {
					t.Fatal(got.err)
				}
				want := "cancelled"
				if mode == "leader-exit" || mode == "escaped-exit" {
					want = "completed"
				}
				if got.result.Status != want || got.result.StopConfirmed == nil || !*got.result.StopConfirmed || got.result.Background {
					t.Fatalf("unexpected result: %+v", got.result)
				}
			case <-time.After(8 * time.Second):
				t.Fatal("foreground command did not settle")
			}
			if _, err := os.Stat(fmt.Sprintf("/proc/%d", pid)); !os.IsNotExist(err) {
				t.Fatalf("grandchild survived confirmed termination: %v", err)
			}
			service.Processes.mu.Lock()
			retained := len(service.Processes.runs)
			service.Processes.mu.Unlock()
			if retained != 0 {
				t.Fatal("completed run retained in cancellation registry")
			}
		})
	}
}

func TestUnconfirmedTerminationRemainsUnconfirmedOnCancellationRetry(t *testing.T) {
	service, _ := newTestService(t)
	bound := identity()
	_, err := service.Processes.Run(context.Background(), Call{Identity: bound, Target: "sandbox"}, terminalArguments{Command: `kill -KILL "$PPID"; exit 0`, TimeoutMS: 1000})
	if err == nil {
		t.Fatal("lost supervisor was treated as confirmed termination")
	}
	run := RunIdentity{RunID: bound.RunID, ScopeID: bound.ScopeID, LifecycleID: bound.LifecycleID, ExecutionContext: bound.ExecutionContext}
	for range 2 {
		if service.CancelRun(run) {
			t.Fatal("cancellation retry forgot unconfirmed termination")
		}
	}
}

func TestForegroundOutputBoundariesAndExitStatus(t *testing.T) {
	service, _ := newTestService(t)
	service.Processes.MaxOutput = 1024
	result, err := service.Processes.Run(context.Background(), Call{Identity: identity(), Target: "sandbox"}, terminalArguments{Command: "printf 'Authorization: Bearer secret-canary\\n'; printf visible; printf stderr-visible >&2; exit 7"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "failed" || result.ExitCode == nil || *result.ExitCode != 7 || strings.Contains(result.Stdout, "secret-canary") || !strings.Contains(result.Stdout, "visible") || result.Stderr != "stderr-visible" {
		t.Fatalf("unexpected result: %+v", result)
	}
	result, err = service.Processes.Run(context.Background(), Call{Identity: identity(), Target: "sandbox"}, terminalArguments{Command: "python3 -c 'import sys; sys.stdout.write(\"x\"*100000); sys.stderr.write(\"y\"*100000)'"})
	if err != nil {
		t.Fatal(err)
	}
	for _, output := range []string{result.Stdout, result.Stderr} {
		if len(output) > 1100 || !strings.Contains(output, "[output truncated by platform manager]") {
			t.Fatalf("output was not bounded: %d bytes", len(output))
		}
	}
}

func TestForegroundRejectsRemovedExecutionModes(t *testing.T) {
	service, _ := newTestService(t)
	for _, args := range []terminalArguments{{Command: "true", Background: true}, {Command: "true", TimeoutMS: -1}, {Command: "true", TimeoutMS: 3_600_001}} {
		if _, err := service.Processes.Run(context.Background(), Call{Identity: identity(), Target: "sandbox"}, args); err == nil {
			t.Fatalf("unsupported terminal arguments accepted: %+v", args)
		}
	}
	if _, err := service.Processes.Run(context.Background(), Call{Identity: identity(), Target: "host"}, terminalArguments{Command: "true"}); err == nil {
		t.Fatal("host command executed")
	}
}

func TestPrivateMCPReturnsRawOutputWithoutRetention(t *testing.T) {
	service, root := newTestService(t)
	secret := "mcp-private-secret-canary"
	args, _ := json.Marshal(terminalArguments{Command: "printf 'Bearer " + secret + "'; printf 'stderr-private' >&2"})
	request := AuditRequest{Identity: identity(), AuditID: "mcp-private", Target: "sandbox", Operation: "terminal", Action: "run", Arguments: args, Details: map[string]any{"tool": "mcp", "action": "call", "arguments": map[string]any{"server": "local", "tool": "echo", "arguments": map[string]any{"token": secret}}}}
	receipt, err := service.Audit(request)
	if err != nil {
		t.Fatal(err)
	}
	call := callForReceipt(request, receipt, "run", args)
	response, err := service.Terminal(context.Background(), call)
	if err != nil {
		t.Fatal(err)
	}
	result := response["result"].(ProcessSnapshot)
	if result.Stdout != "Bearer "+secret || result.Stderr != "stderr-private" {
		t.Fatalf("MCP output was redacted before delivery: %+v", result)
	}
	if strings.Contains(result.Command, secret) || !strings.Contains(result.Command, "MCP call") {
		t.Fatalf("unsafe MCP command projection: %q", result.Command)
	}
	if _, err := service.Terminal(context.Background(), call); err == nil {
		t.Fatal("MCP receipt was replayed")
	}
	err = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if strings.Contains(string(data), secret) || strings.Contains(string(data), "stderr-private") {
			return fmt.Errorf("MCP output retained at %s", path)
		}
		for _, suffix := range []string{".pid", ".out", ".err", ".exit"} {
			if strings.HasSuffix(path, suffix) {
				return fmt.Errorf("command artifact created: %s", path)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// Block before sandbox creation, where concurrent calls have not started an
// attached process yet. Each request can settle independently.
type admissionEngine struct {
	engineStub
	entered chan chan error
}

func (e *admissionEngine) PrepareManagedImage(ctx context.Context, _, _ string) error {
	release := make(chan error, 1)
	select {
	case e.entered <- release:
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case err := <-release:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func TestForegroundAdmissionPendingEnsure(t *testing.T) {
	for _, global := range []bool{false, true} {
		t.Run(fmt.Sprintf("global=%t", global), func(t *testing.T) {
			service, _ := newTestService(t)
			engine := &admissionEngine{entered: make(chan chan error, 129)}
			service.Processes.Sandboxes.Engine = engine
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			limit := 16
			want := "Agent scope family already owns 16 running processes"
			if global {
				limit = 128
				want = "Manager already owns 128 running processes"
			}
			results := make(chan error, 129)
			start := func(scope string) {
				bound := identity()
				bound.ScopeID = scope
				go func() {
					_, err := service.Processes.Run(ctx, Call{Identity: bound, Target: "sandbox"}, terminalArguments{Command: "true"})
					results <- err
				}()
			}
			awaitEnsure := func() chan error {
				t.Helper()
				select {
				case release := <-engine.entered:
					return release
				case err := <-results:
					t.Fatalf("call rejected before capacity: %v", err)
				case <-time.After(5 * time.Second):
					t.Fatal("admitted call did not reach Ensure")
				}
				return nil
			}
			releases := make([]chan error, 0, limit)
			for i := range limit {
				scope := fmt.Sprintf("private:1/delegate/%d", i)
				if global {
					scope = fmt.Sprintf("private:%d", i)
				}
				start(scope)
				releases = append(releases, awaitEnsure())
			}
			scope := "private:1"
			if global {
				scope = "private:999"
			}
			start(scope)
			select {
			case err := <-results:
				if err == nil || err.Error() != want {
					t.Fatalf("capacity rejection = %v, want %q", err, want)
				}
			case <-engine.entered:
				t.Fatal("over-capacity request reached Ensure")
			case <-time.After(5 * time.Second):
				t.Fatal("over-capacity request did not settle")
			}
			// Similar textual prefixes are independent, not family members.
			if !global {
				for _, unrelated := range []string{"private:10", "private:1/other", "private:1/delegates/child"} {
					start(unrelated)
					awaitEnsure() <- errors.New("independent scope")
					if err := <-results; err == nil || !strings.Contains(err.Error(), "independent scope") {
						t.Fatalf("unrelated scope was rejected: %v", err)
					}
				}
			}
			releases[0] <- errors.New("ensure failed")
			if err := <-results; err == nil || !strings.Contains(err.Error(), "ensure failed") {
				t.Fatalf("pending call did not settle: %v", err)
			}
			// The freed slot can reach Ensure and execute a real wrapper.
			start(scope)
			awaitEnsure() <- nil
			select {
			case err := <-results:
				if err != nil {
					t.Fatalf("released slot could not execute: %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("replacement command did not settle")
			}
			cancel()
			for range limit - 1 {
				select {
				case err := <-results:
					if !errors.Is(err, context.Canceled) {
						t.Fatalf("pending cancellation = %v", err)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("pending call did not cancel")
				}
			}
		})
	}
}

type unconfirmedAdmissionEngine struct{ engineStub }

func (unconfirmedAdmissionEngine) ExecArgs(driver.SandboxSpec, string, string, []string) (string, []string) {
	return "/bin/sh", []string{"-c", "exit 0"}
}

func TestForegroundAdmissionReleasesUnconfirmedCalls(t *testing.T) {
	service, _ := newTestService(t)
	service.Processes.Engine = unconfirmedAdmissionEngine{}
	bound := identity()
	for range 17 {
		_, err := service.Processes.Run(context.Background(), Call{Identity: bound, Target: "sandbox"}, terminalArguments{Command: "true"})
		if err == nil || !strings.Contains(err.Error(), "termination was not confirmed") {
			t.Fatalf("settled unconfirmed call consumed admission: %v", err)
		}
	}
	if service.CancelRun(RunIdentity{RunID: bound.RunID, ScopeID: bound.ScopeID, LifecycleID: bound.LifecycleID, ExecutionContext: bound.ExecutionContext}) {
		t.Fatal("releasing admission discarded unconfirmed cancellation evidence")
	}
	service.Processes.Engine = engineStub{}
	result, err := service.Processes.Run(context.Background(), Call{Identity: bound, Target: "sandbox"}, terminalArguments{Command: "printf admitted"})
	if err != nil || result.Stdout != "admitted" || result.Status != "completed" {
		t.Fatalf("settled unconfirmed calls blocked execution: %+v, %v", result, err)
	}
}

func TestForegroundAdmissionHoldsRunningSlotsUntilCancellationSettles(t *testing.T) {
	service, root := newTestService(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	results := make(chan error, 16)
	bound := identity()
	for i := range 16 {
		marker := filepath.Join(root, fmt.Sprintf("started-%d", i))
		go func() {
			_, err := service.Processes.Run(ctx, Call{Identity: bound, Target: "sandbox"}, terminalArguments{Command: "printf started > " + shellQuote(marker) + "; sleep 60"})
			results <- err
		}()
		until := time.Now().Add(5 * time.Second)
		for {
			if _, err := os.Stat(marker); err == nil {
				break
			}
			if time.Now().After(until) {
				t.Fatal("command did not start")
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	if _, err := service.Processes.Run(context.Background(), Call{Identity: bound, Target: "sandbox"}, terminalArguments{Command: "true"}); err == nil || err.Error() != "Agent scope family already owns 16 running processes" {
		t.Fatalf("running commands did not hold admission: %v", err)
	}
	if !service.CancelRun(RunIdentity{RunID: bound.RunID, ScopeID: bound.ScopeID, LifecycleID: bound.LifecycleID, ExecutionContext: bound.ExecutionContext}) {
		t.Fatal("running commands did not confirm cancellation")
	}
	for range 16 {
		select {
		case err := <-results:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("cancelled command did not settle")
		}
	}
	result, err := service.Processes.Run(context.Background(), Call{Identity: bound, Target: "sandbox"}, terminalArguments{Command: "printf released"})
	if err != nil || result.Stdout != "released" || result.Status != "completed" {
		t.Fatalf("cancelled commands did not release admission: %+v, %v", result, err)
	}
}
