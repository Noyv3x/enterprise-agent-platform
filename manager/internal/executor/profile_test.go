package executor

import (
	"context"
	"encoding/json"
	"testing"
)

func TestAuditProfileBindingAndLegacyDefault(t *testing.T) {
	for _, profile := range []string{"", "agent", "chat"} {
		t.Run("profile="+profile, func(t *testing.T) {
			service, _ := newTestService(t)
			original := identity()
			original.ExecutionContext.Profile = profile
			request := AuditRequest{Identity: original, AuditID: "audit-profile", Target: "sandbox", Operation: "read_file", Action: "read", Arguments: json.RawMessage(`{"path":"/workspace/profile.txt"}`)}
			receipt, err := service.Audit(request)
			if err != nil {
				t.Fatal(err)
			}
			call := Call{Identity: original, AuditID: receipt.AuditID, ExecutorID: receipt.ExecutorID, Target: "sandbox", Action: "read", Arguments: request.Arguments}
			if profile == "chat" {
				call.ExecutionContext.Profile = "agent"
			} else {
				call.ExecutionContext.Profile = "chat"
			}
			if _, err := service.Audits.Consume(call, "read_file"); err == nil {
				t.Fatal("profile drift consumed an audit receipt")
			}
			call.ExecutionContext.Profile = profile
			if profile == "" {
				call.ExecutionContext.Profile = "agent"
			} else if profile == "agent" {
				call.ExecutionContext.Profile = ""
			}
			if _, err := service.Audits.Consume(call, "read_file"); err != nil {
				t.Fatalf("original/default profile must retain its receipt: %v", err)
			}
		})
	}
	service, _ := newTestService(t)
	invalid := identity()
	invalid.ExecutionContext.Profile = "privileged"
	if _, err := service.Audit(AuditRequest{Identity: invalid, AuditID: "invalid-profile", Target: "sandbox", Operation: "read_file", Action: "read", Arguments: json.RawMessage(`{"path":"/workspace/profile.txt"}`)}); err == nil {
		t.Fatal("unknown profile accepted")
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
