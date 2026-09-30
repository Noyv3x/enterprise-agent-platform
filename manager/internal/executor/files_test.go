package executor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func executeSandboxFile(t *testing.T, service *Service, action string, arguments any) (string, map[string]any, error) {
	t.Helper()
	raw, err := json.Marshal(arguments)
	if err != nil {
		t.Fatal(err)
	}
	return service.Files.Execute(context.Background(), Call{
		Identity:  identity(),
		Target:    "sandbox",
		Action:    action,
		Arguments: raw,
	})
}

func TestSandboxFileActionsSupportNestedRegularFiles(t *testing.T) {
	service, _ := newTestService(t)
	path := "/workspace/nested/file.txt"

	if _, _, err := executeSandboxFile(t, service, "write", fileWriteArguments{Path: path, Content: "alpha\n"}); err != nil {
		t.Fatal(err)
	}
	content, _, err := executeSandboxFile(t, service, "read", fileReadArguments{Path: path})
	if err != nil {
		t.Fatal(err)
	}
	if content != "alpha\n" {
		t.Fatalf("unexpected file content %q", content)
	}

}

func TestSandboxFileActionsRejectSymlinkEscape(t *testing.T) {
	service, root := newTestService(t)
	if _, _, err := executeSandboxFile(t, service, "write", fileWriteArguments{Path: "/workspace/inside.txt", Content: "inside"}); err != nil {
		t.Fatal(err)
	}

	workspace := filepath.Join(root, "data", "workspaces", "user-1")
	outside := filepath.Join(root, "outside")
	if err := os.MkdirAll(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	secretPath := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(secretPath, []byte("outside-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(workspace, "escape")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secretPath, filepath.Join(workspace, "final-link.txt")); err != nil {
		t.Fatal(err)
	}

	for _, path := range []string{"/workspace/escape/secret.txt", "/workspace/final-link.txt"} {
		t.Run("read_"+filepath.Base(path), func(t *testing.T) {
			if _, _, err := executeSandboxFile(t, service, "read", fileReadArguments{Path: path}); err == nil {
				t.Fatal("read followed a symbolic link")
			}
		})
		t.Run("write_"+filepath.Base(path), func(t *testing.T) {
			if _, _, err := executeSandboxFile(t, service, "write", fileWriteArguments{Path: path, Content: "overwritten"}); err == nil {
				t.Fatal("write followed a symbolic link")
			}
		})
	}

	if _, _, err := executeSandboxFile(t, service, "write", fileWriteArguments{Path: "/workspace/escape/new.txt", Content: "created outside"}); err == nil {
		t.Fatal("write created a file through a parent symbolic link")
	}
	secret, err := os.ReadFile(secretPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(secret) != "outside-secret" {
		t.Fatalf("outside file was modified: %q", secret)
	}
	if _, err := os.Stat(filepath.Join(outside, "new.txt")); !os.IsNotExist(err) {
		t.Fatalf("write created an outside file: %v", err)
	}
}

func TestManagedWriteKeepsTheVerifiedParentDirectoryPinned(t *testing.T) {
	service, root := newTestService(t)
	if _, _, err := executeSandboxFile(t, service, "write", fileWriteArguments{Path: "/workspace/target/file.txt", Content: "original"}); err != nil {
		t.Fatal(err)
	}
	call := Call{Identity: identity(), Target: "sandbox"}
	path, err := service.Files.sandboxPath(call, "/workspace/target/file.txt")
	if err != nil {
		t.Fatal(err)
	}
	parent, leaf, err := openManagedParent(path, false)
	if err != nil {
		t.Fatal(err)
	}
	defer parent.Close()

	workspace := filepath.Join(root, "data", "workspaces", "user-1")
	target := filepath.Join(workspace, "target")
	pinned := filepath.Join(workspace, "target-pinned")
	if err := os.Rename(target, pinned); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "file.txt"), []byte("replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeManagedFileAt(parent, leaf, []byte("patched"), 0o600, ".agent-platform"); err != nil {
		t.Fatal(err)
	}
	if content, err := os.ReadFile(filepath.Join(pinned, "file.txt")); err != nil || string(content) != "patched" {
		t.Fatalf("pinned file was not patched: %q %v", content, err)
	}
	if content, err := os.ReadFile(filepath.Join(target, "file.txt")); err != nil || string(content) != "replacement" {
		t.Fatalf("replacement pathname was modified: %q %v", content, err)
	}
}

func TestSandboxAttachmentsAreMappedBeforeWorkspaceAndRemainReadOnly(t *testing.T) {
	service, root := newTestService(t)
	if _, _, err := executeSandboxFile(t, service, "write", fileWriteArguments{Path: "/workspace/inside.txt", Content: "inside"}); err != nil {
		t.Fatal(err)
	}

	attachmentRoot := filepath.Join(root, "data", "attachments", "private", "1")
	attachmentPath := filepath.Join(attachmentRoot, "note.txt")
	if err := os.WriteFile(attachmentPath, []byte("actual-attachment"), 0o600); err != nil {
		t.Fatal(err)
	}
	shadowRoot := filepath.Join(root, "data", "workspaces", "user-1", ".agent-platform", "attachments")
	if err := os.MkdirAll(shadowRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(shadowRoot, "note.txt"), []byte("workspace-shadow"), 0o600); err != nil {
		t.Fatal(err)
	}

	logicalPath := "/workspace/.agent-platform/attachments/note.txt"
	content, _, err := executeSandboxFile(t, service, "read", fileReadArguments{Path: logicalPath})
	if err != nil {
		t.Fatal(err)
	}
	if content != "actual-attachment" {
		t.Fatalf("attachment overlay did not take precedence: %q", content)
	}
	if _, _, err := executeSandboxFile(t, service, "write", fileWriteArguments{Path: logicalPath, Content: "overwritten"}); err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Fatalf("attachment write was not rejected as read-only: %v", err)
	}
	attachmentBytes, err := os.ReadFile(attachmentPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(attachmentBytes) != "actual-attachment" {
		t.Fatalf("read-only attachment was modified: %q", attachmentBytes)
	}

	outside := filepath.Join(root, "attachment-outside")
	if err := os.MkdirAll(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("attachment-outside-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(attachmentRoot, "escape")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := executeSandboxFile(t, service, "read", fileReadArguments{Path: "/workspace/.agent-platform/attachments/escape/secret.txt"}); err == nil {
		t.Fatal("attachment read followed a parent symbolic link")
	}
}
