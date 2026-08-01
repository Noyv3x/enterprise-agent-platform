//go:build linux

package selfupdate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
)

func TestSelfUpdateObservationRetainsRecoveryLockAndDetectsChange(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(root, "manager-binaries.json")
	state := State{SchemaVersion: 1, Current: &Version{
		Version: strings.Repeat("a", 40), SourceCommit: strings.Repeat("a", 40),
		Path: filepath.Join(root, "current"), SHA256: strings.Repeat("b", 64),
		VerifiedAt: time.Unix(1, 0).UTC(), PlatformCommitted: true,
	}, UpdatedAt: time.Unix(1, 0).UTC()}
	if err := atomicfile.WriteJSON(statePath, state, 0o600); err != nil {
		t.Fatal(err)
	}
	manager := &Manager{Root: root, StatePath: statePath}
	lease, err := manager.OpenObservation()
	if err != nil {
		t.Fatal(err)
	}
	if competing, err := acquireRecoveryLock(root); err == nil {
		competing()
		t.Fatal("self-update observation did not retain recovery exclusion")
	}
	changed := state
	changed.UpdatedAt = time.Unix(2, 0).UTC()
	if err := atomicfile.WriteJSON(statePath, changed, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := lease.VerifyUnchanged(); err == nil {
		t.Fatal("self-update mutation inside the lease was accepted")
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	if release, err := acquireRecoveryLock(root); err != nil {
		t.Fatalf("observation did not release recovery lock: %v", err)
	} else {
		release()
	}
	_ = os.Remove(statePath)
}
