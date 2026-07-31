package executor

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/sandbox"
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

func executeHostFile(t *testing.T, service *Service, action string, arguments any) (string, map[string]any, error) {
	t.Helper()
	raw, err := json.Marshal(arguments)
	if err != nil {
		t.Fatal(err)
	}
	return service.Files.Execute(context.Background(), Call{
		Identity:  identity(),
		Target:    "host",
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

	if _, _, err := executeSandboxFile(t, service, "patch", filePatchArguments{Path: path, OldText: "alpha", NewText: "beta"}); err != nil {
		t.Fatal(err)
	}
	result, details, err := executeSandboxFile(t, service, "search", fileSearchArguments{Path: "/workspace/nested", Query: "beta"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, "file.txt:1:beta") || details["count"] != 1 {
		t.Fatalf("unexpected search result %q (%#v)", result, details)
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
		t.Run("patch_"+filepath.Base(path), func(t *testing.T) {
			if _, _, err := executeSandboxFile(t, service, "patch", filePatchArguments{Path: path, OldText: "outside-secret", NewText: "overwritten"}); err == nil {
				t.Fatal("patch followed a symbolic link")
			}
		})
	}

	if _, _, err := executeSandboxFile(t, service, "search", fileSearchArguments{Path: "/workspace/escape", Query: "outside-secret"}); err == nil {
		t.Fatal("search followed a symbolic-link root")
	}
	if _, _, err := executeSandboxFile(t, service, "write", fileWriteArguments{Path: "/workspace/escape/new.txt", Content: "created outside"}); err == nil {
		t.Fatal("write created a file through a parent symbolic link")
	}
	result, _, err := executeSandboxFile(t, service, "search", fileSearchArguments{Path: "/workspace", Query: "outside-secret"})
	if err != nil {
		t.Fatal(err)
	}
	if result != "No matches" {
		t.Fatalf("search escaped through a child symbolic link: %q", result)
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

func TestHostFileActionsRejectParentSymlinksAndManagerPaths(t *testing.T) {
	service, root := newTestService(t)
	if _, _, err := executeHostFile(t, service, "write", fileWriteArguments{Path: "/workspace/inside.txt", Content: "inside"}); err != nil {
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

	for action, arguments := range map[string]any{
		"read":   fileReadArguments{Path: "/workspace/escape/secret.txt"},
		"write":  fileWriteArguments{Path: "/workspace/escape/new.txt", Content: "created outside"},
		"patch":  filePatchArguments{Path: "/workspace/escape/secret.txt", OldText: "outside", NewText: "changed"},
		"search": fileSearchArguments{Path: "/workspace/escape", Query: "outside-secret"},
	} {
		t.Run(action+"_parent_symlink", func(t *testing.T) {
			if _, _, err := executeHostFile(t, service, action, arguments); err == nil || !strings.Contains(err.Error(), "symbolic link") {
				t.Fatalf("host %s followed a parent symlink: %v", action, err)
			}
		})
	}
	if content, err := os.ReadFile(secretPath); err != nil || string(content) != "outside-secret" {
		t.Fatalf("outside file changed: %q %v", content, err)
	}
	if _, err := os.Stat(filepath.Join(outside, "new.txt")); !os.IsNotExist(err) {
		t.Fatalf("host write escaped through symlink: %v", err)
	}

	managerSecret := filepath.Join(root, "manager", "secrets", "manager-token")
	if err := os.MkdirAll(filepath.Dir(managerSecret), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(managerSecret, []byte("manager-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	for action, arguments := range map[string]any{
		"read":   fileReadArguments{Path: managerSecret},
		"write":  fileWriteArguments{Path: managerSecret, Content: "changed"},
		"patch":  filePatchArguments{Path: managerSecret, OldText: "manager", NewText: "changed"},
		"search": fileSearchArguments{Path: filepath.Dir(managerSecret), Query: "manager-secret"},
	} {
		t.Run(action+"_manager_path", func(t *testing.T) {
			if _, _, err := executeHostFile(t, service, action, arguments); err == nil || !strings.Contains(err.Error(), "protected") {
				t.Fatalf("host %s accessed Manager state: %v", action, err)
			}
		})
	}

	result, _, err := executeHostFile(t, service, "search", fileSearchArguments{Path: root, Query: "manager-secret"})
	if err != nil {
		t.Fatal(err)
	}
	if result != "No matches" {
		t.Fatalf("broad host search entered protected Manager state: %q", result)
	}
}

func TestManagedPatchKeepsTheVerifiedParentDirectoryPinned(t *testing.T) {
	service, root := newTestService(t)
	if _, _, err := executeHostFile(t, service, "write", fileWriteArguments{Path: "/workspace/target/file.txt", Content: "original"}); err != nil {
		t.Fatal(err)
	}
	call := Call{Identity: identity(), Target: "host"}
	path, err := service.Files.hostPath(call, "/workspace/target/file.txt", sandbox.HostPathWrite)
	if err != nil {
		t.Fatal(err)
	}
	file, parent, leaf, err := openManagedRegularForUpdate(path)
	if err != nil {
		t.Fatal(err)
	}
	defer parent.Close()
	data, err := io.ReadAll(file)
	_ = file.Close()
	if err != nil || string(data) != "original" {
		t.Fatalf("read pinned file: %q %v", data, err)
	}

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
	if err := writeManagedFileAt(parent, leaf, []byte("patched"), 0o600, ".ubitech"); err != nil {
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
	shadowRoot := filepath.Join(root, "data", "workspaces", "user-1", ".ubitech", "attachments")
	if err := os.MkdirAll(shadowRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(shadowRoot, "note.txt"), []byte("workspace-shadow"), 0o600); err != nil {
		t.Fatal(err)
	}

	logicalPath := "/workspace/.ubitech/attachments/note.txt"
	content, _, err := executeSandboxFile(t, service, "read", fileReadArguments{Path: logicalPath})
	if err != nil {
		t.Fatal(err)
	}
	if content != "actual-attachment" {
		t.Fatalf("attachment overlay did not take precedence: %q", content)
	}
	result, _, err := executeSandboxFile(t, service, "search", fileSearchArguments{Path: "/workspace/.ubitech/attachments", Query: "actual-attachment"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, "note.txt:1:actual-attachment") {
		t.Fatalf("attachment search used the wrong root: %q", result)
	}

	if _, _, err := executeSandboxFile(t, service, "write", fileWriteArguments{Path: logicalPath, Content: "overwritten"}); err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Fatalf("attachment write was not rejected as read-only: %v", err)
	}
	if _, _, err := executeSandboxFile(t, service, "patch", filePatchArguments{Path: logicalPath, OldText: "actual", NewText: "changed"}); err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Fatalf("attachment patch was not rejected as read-only: %v", err)
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
	if _, _, err := executeSandboxFile(t, service, "read", fileReadArguments{Path: "/workspace/.ubitech/attachments/escape/secret.txt"}); err == nil {
		t.Fatal("attachment read followed a parent symbolic link")
	}
	result, _, err = executeSandboxFile(t, service, "search", fileSearchArguments{Path: "/workspace/.ubitech/attachments", Query: "attachment-outside-secret"})
	if err != nil {
		t.Fatal(err)
	}
	if result != "No matches" {
		t.Fatalf("attachment search escaped through a symbolic link: %q", result)
	}
}
