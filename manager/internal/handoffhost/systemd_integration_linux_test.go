//go:build linux

package handoffhost

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

// This test is opt-in because it enables a real, collision-resistant user
// systemd unit. It exercises the exact same persistent-unit boundary as
// production and removes only the proof-bound unit it created.
func TestPersistentHelperUserSystemdIntegration(t *testing.T) {
	if os.Getenv("UBITECH_SYSTEMD_INTEGRATION") != "1" {
		t.Skip("set UBITECH_SYSTEMD_INTEGRATION=1 to run the user-systemd integration test")
	}
	if _, err := exec.LookPath("systemctl"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	if output, err := exec.CommandContext(ctx, "systemctl", "--user", "show-environment").CombinedOutput(); err != nil {
		t.Fatalf("user systemd is unavailable: %v: %s", err, output)
	}

	base := shortTempDir(t)
	helperSource := filepath.Join(base, "helper.go")
	if err := os.WriteFile(helperSource, []byte(`package main
import ("os/signal"; "syscall")
func main(){ c:=make(chan os.Signal,1); signal.Notify(c,syscall.SIGTERM,syscall.SIGINT); <-c }
`), 0o600); err != nil {
		t.Fatal(err)
	}
	artifact := filepath.Join(base, "verified-helper")
	if output, err := exec.CommandContext(ctx, "go", "build", "-o", artifact, helperSource).CombinedOutput(); err != nil {
		t.Fatalf("build integration helper: %v: %s", err, output)
	}
	if err := os.Chmod(artifact, 0o700); err != nil {
		t.Fatal(err)
	}
	transactionID := randomTestTransactionID(t)
	transactionDirectory := filepath.Join(base, transactionID)
	if err := os.Mkdir(transactionDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	journal := filepath.Join(transactionDirectory, journalBasename)
	if err := os.WriteFile(journal, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	unitDirectory := filepath.Join(home, ".config", "systemd", "user")
	if err := os.MkdirAll(unitDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	request := ArmRequest{
		TargetProfile: identity.TargetProfile(), TransactionID: transactionID,
		TransactionDirectory: transactionDirectory, ArtifactPath: artifact,
		ArtifactSHA256: shaFileForTest(t, artifact), UnitDirectory: unitDirectory, JournalPath: journal,
	}
	host := &LinuxHost{}
	spec, err := host.Resolve(request)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = CommandRunner{}.Run(cleanupCtx, "systemctl", "--user", "disable", "--now", spec.UnitName)
		_ = os.Remove(spec.UnitPath)
		_, _ = CommandRunner{}.Run(cleanupCtx, "systemctl", "--user", "daemon-reload")
	})
	result, err := host.Arm(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := host.Inspect(ctx, result.Spec); err != nil {
		t.Fatal(err)
	}
	removed, err := host.Remove(ctx, RemovalRequest{Spec: result.Spec, ExpectedProof: result.Proof})
	if err != nil {
		t.Fatal(err)
	}
	if !removed.UnitRemoved || !removed.ExecutableRemoved {
		t.Fatalf("incomplete integration removal: %#v", removed)
	}
}
