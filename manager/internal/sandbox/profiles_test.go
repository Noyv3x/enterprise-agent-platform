package sandbox

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProfilesBindRecoverAndReapIndependently(t *testing.T) {
	root := t.TempDir()
	engine := &sandboxEngine{}
	data, state := filepath.Join(root, "data"), filepath.Join(root, "manager", "sandboxes.json")
	image := "sandbox@sha256:" + strings.Repeat("a", 64)
	manager, err := Open(testActiveProfile, engine, data, state, image, "core", 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1, 0)
	agent, err := manager.Ensure(context.Background(), "agent", "user-7", now)
	if err != nil {
		t.Fatal(err)
	}
	if agent.Memory != "2g" || agent.MemorySwap != "2g" || agent.CPUs != "2" || agent.PidsLimit != 1024 || agent.Network != "core" || agent.Attachments == "" {
		t.Fatalf("agent resources: %#v", agent)
	}
	chat, err := manager.Ensure(context.Background(), "chat", "chat-user-7", now, "chat")
	if err != nil {
		t.Fatal(err)
	}
	if chat.Memory != "768m" || chat.MemorySwap != "768m" || chat.CPUs != "1" || chat.PidsLimit != 256 || chat.Network != "none" || chat.Attachments != "" || chat.Workspace != filepath.Join(data, "workspaces", "chat", "user-7") {
		t.Fatalf("chat resources: %#v", chat)
	}
	marker := filepath.Join(chat.Workspace, "conversation.txt")
	if err := os.WriteFile(marker, []byte("retained"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, request := range []struct{ id, workspace, profile string }{
		{"chat", "chat-user-7", "agent"}, {"chat", "chat-user-8", "chat"}, {"agent", "user-7", "chat"}, {"invalid", "chat-user-../8", "chat"}, {"invalid", "user-7", "other"},
	} {
		if _, err := manager.Ensure(context.Background(), request.id, request.workspace, now, request.profile); err == nil {
			t.Fatalf("accepted invalid binding %#v", request)
		}
	}
	recovered, err := Open(testActiveProfile, engine, data, state, image, "core", 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := recovered.Ensure(context.Background(), "chat", "chat-user-7", now); err == nil {
		t.Fatal("recovery forgot chat binding")
	}
	restored, err := recovered.Ensure(context.Background(), "chat", "chat-user-7", now, "chat")
	if err != nil {
		t.Fatal(err)
	}
	if restored != chat {
		t.Fatalf("recovered spec changed: %#v != %#v", restored, chat)
	}
	stopped, err := recovered.Reap(context.Background(), now.Add(3*time.Minute))
	if err != nil || len(stopped) != 1 || stopped[0] != "chat" {
		t.Fatalf("chat idle stop: %v %v", stopped, err)
	}
	stopped, err = recovered.Reap(context.Background(), now.Add(10*time.Minute))
	if err != nil || len(stopped) != 1 || stopped[0] != "agent" {
		t.Fatalf("agent idle stop: %v %v", stopped, err)
	}
	body, err := os.ReadFile(marker)
	if err != nil || string(body) != "retained" {
		t.Fatalf("workspace lost: %q %v", body, err)
	}
}

func TestChatProfileRejectsSymlinkedWorkspaceRoot(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "data")
	if err := os.MkdirAll(filepath.Join(data, "workspaces"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), filepath.Join(data, "workspaces", "chat")); err != nil {
		t.Fatal(err)
	}
	engine := &sandboxEngine{}
	manager, err := Open(testActiveProfile, engine, data, filepath.Join(root, "manager", "sandboxes.json"), "sandbox@sha256:"+strings.Repeat("a", 64), "core", 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Ensure(context.Background(), "chat", "chat-user-7", time.Now(), "chat"); err == nil {
		t.Fatal("accepted symlinked chat workspace")
	}
	if len(engine.ensured) != 0 {
		t.Fatal("unsafe workspace reached Docker")
	}
}

func TestRecoveryRejectsChangedChatProfile(t *testing.T) {
	root := t.TempDir()
	data, state := filepath.Join(root, "data"), filepath.Join(root, "manager", "sandboxes.json")
	engine := &sandboxEngine{}
	image := "sandbox@sha256:" + strings.Repeat("a", 64)
	manager, err := Open(testActiveProfile, engine, data, state, image, "core", 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Ensure(context.Background(), "chat", "chat-user-7", time.Now(), "chat"); err != nil {
		t.Fatal(err)
	}
	record := manager.registry.Records["chat"]
	record.Profile = ""
	manager.registry.Records["chat"] = record
	if err := manager.persistLocked(); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(testActiveProfile, engine, data, state, image, "core", 10*time.Minute); err == nil {
		t.Fatal("recovery accepted a chat workspace rebound to agent profile")
	}
}
