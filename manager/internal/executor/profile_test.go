package executor

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
)

func TestAuditProfileBindingAndLegacyDefault(t *testing.T) {
	for _, profile := range []string{"", "agent", "chat"} {
		t.Run("profile="+profile, func(t *testing.T) {
			service, _ := newTestService(t)
			original := identity()
			original.ExecutionContext.Profile = profile
			request := AuditRequest{Identity: original, AuditID: "audit-profile", Target: "sandbox", Operation: "process", Action: "list", Arguments: json.RawMessage(`{}`)}
			receipt, err := service.Audit(request)
			if err != nil {
				t.Fatal(err)
			}
			call := Call{Identity: original, AuditID: receipt.AuditID, ExecutorID: receipt.ExecutorID, Target: "sandbox", Action: "list", Arguments: request.Arguments}
			if profile == "chat" {
				call.ExecutionContext.Profile = "agent"
			} else {
				call.ExecutionContext.Profile = "chat"
			}
			if _, err := service.Audits.Consume(call, "process"); err == nil {
				t.Fatal("profile drift consumed an audit receipt")
			}
			call.ExecutionContext.Profile = profile
			if profile == "" {
				call.ExecutionContext.Profile = "agent"
			} else if profile == "agent" {
				call.ExecutionContext.Profile = ""
			}
			if _, err := service.Audits.Consume(call, "process"); err != nil {
				t.Fatalf("original/default profile must retain its receipt: %v", err)
			}
		})
	}
	service, _ := newTestService(t)
	invalid := identity()
	invalid.ExecutionContext.Profile = "privileged"
	if _, err := service.Audit(AuditRequest{Identity: invalid, AuditID: "invalid-profile", Target: "sandbox", Operation: "process", Action: "list", Arguments: json.RawMessage(`{}`)}); err == nil {
		t.Fatal("unknown profile accepted")
	}
}

func TestProcessProfileSurvivesRecoveryAndFencesOperations(t *testing.T) {
	for _, profile := range []string{"", "agent", "chat"} {
		t.Run("profile="+profile, func(t *testing.T) {
			service, _ := newTestService(t)
			m := service.Processes
			workspace := "user-1"
			if profile == "chat" {
				workspace = "chat-user-1"
			}
			spec, err := m.Sandboxes.Ensure(context.Background(), "private-1", workspace, time.Now(), profile)
			if err != nil {
				t.Fatal(err)
			}
			now := time.Now().UTC()
			process := &managedProcess{
				snapshot:  ProcessSnapshot{ID: "proc_profile", RunID: "run-1", ScopeKey: "private:1", LifecycleID: "life-1", Target: "sandbox", Status: "completed", StartedAt: now, FinishedAt: &now, Background: true},
				sandboxID: "private-1", workspaceID: workspace, profile: profile, spec: spec,
				stateFile:         filepath.Join(filepath.Dir(m.Sandboxes.StatePath), "processes", spec.AgentHash, "proc_profile.json"),
				completionOwnerID: strings.Repeat("a", 64), done: make(chan struct{}),
				stdout: &boundedBuffer{limit: 1024}, stderr: &boundedBuffer{limit: 1024},
			}
			close(process.done)
			if err := m.persistProcess(process); err != nil {
				t.Fatal(err)
			}
			var persisted map[string]any
			if err := atomicfile.ReadJSON(process.stateFile, &persisted); err != nil {
				t.Fatal(err)
			}
			if profile == "chat" {
				if persisted["profile"] != "chat" {
					t.Fatal("chat profile was not persisted")
				}
			} else if _, exists := persisted["profile"]; exists {
				t.Fatal("agent profile must remain legacy-compatible on disk")
			}
			m.recoverSandboxProcesses()
			bound := identity()
			bound.ExecutionContext.WorkspaceID = workspace
			bound.ExecutionContext.Profile = profile
			if _, err := m.Wait(context.Background(), bound.ScopeID, bound.LifecycleID, "sandbox", bound.ExecutionContext, process.snapshot.ID, time.Millisecond); err != nil {
				t.Fatalf("recovered process unavailable with original identity: %v", err)
			}
			wrong := bound
			wrong.ExecutionContext.Profile = "chat"
			if profile == "chat" {
				wrong.ExecutionContext.Profile = ""
			}
			for _, action := range []string{"read", "write", "kill", "wait", "list"} {
				arguments := json.RawMessage(`{"process_id":"proc_profile"}`)
				if action == "list" {
					arguments = json.RawMessage(`{}`)
				}
				receipt, err := service.Audit(AuditRequest{Identity: wrong, AuditID: "audit-" + action, Target: "sandbox", Operation: "process", Action: action, Arguments: arguments})
				if err != nil {
					t.Fatal(err)
				}
				if _, err := service.Process(context.Background(), Call{Identity: wrong, AuditID: receipt.AuditID, ExecutorID: receipt.ExecutorID, Target: "sandbox", Action: action, Arguments: arguments}); err == nil {
					t.Fatalf("%s accepted profile drift", action)
				}
			}
			if _, err := m.Wait(context.Background(), wrong.ScopeID, wrong.LifecycleID, "sandbox", wrong.ExecutionContext, process.snapshot.ID, time.Millisecond); err == nil {
				t.Fatal("direct wait accepted profile drift")
			}
			if m.CancelRun(RunIdentity{RunID: wrong.RunID, ScopeID: wrong.ScopeID, LifecycleID: wrong.LifecycleID, ExecutionContext: wrong.ExecutionContext}) {
				t.Fatal("cancel accepted profile drift")
			}
			if m.AcknowledgeTask(TaskProcessIdentity{TaskIdentity: TaskIdentity{ScopeID: wrong.ScopeID, LifecycleID: wrong.LifecycleID, ExecutionContext: wrong.ExecutionContext, CompletionOwnerID: process.completionOwnerID}, ProcessID: process.snapshot.ID}) {
				t.Fatal("acknowledgement accepted profile drift")
			}
			m.processes = map[string]*managedProcess{}
			process.profile = wrong.ExecutionContext.Profile
			if err := m.persistProcess(process); err != nil {
				t.Fatal(err)
			}
			m.recoverSandboxProcesses()
			if _, exists := m.processes[process.snapshot.ID]; exists {
				t.Fatal("recovered process with profile conflicting with its sandbox")
			}
		})
	}
}

func TestFileAndTerminalKeepChatSandboxProfile(t *testing.T) {
	service, _ := newTestService(t)
	bound := identity()
	bound.ExecutionContext.WorkspaceID = "chat-user-1"
	bound.ExecutionContext.Profile = "chat"
	call := Call{Identity: bound, Target: "sandbox", Action: "write", Arguments: json.RawMessage(`{"path":"/workspace/profile.txt","content":"chat content"}`)}
	if _, _, err := service.Files.Execute(context.Background(), call); err != nil {
		t.Fatal(err)
	}
	call.Action = "read"
	call.Arguments = json.RawMessage(`{"path":"/workspace/profile.txt"}`)
	content, _, err := service.Files.Execute(context.Background(), call)
	if err != nil || content != "chat content" {
		t.Fatalf("chat file read = %q, %v", content, err)
	}
	call.ExecutionContext.Profile = ""
	if _, _, err := service.Files.Execute(context.Background(), call); err == nil {
		t.Fatal("file operation changed chat sandbox to legacy agent profile")
	}
	if _, err := service.Processes.Run(context.Background(), call, terminalArguments{Command: "true"}); err == nil {
		t.Fatal("terminal operation changed chat sandbox to legacy agent profile")
	}
}
