package selfupdate

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
)

func TestCleanupStartupAtomicResiduesUsesDomainWriterProof(t *testing.T) {
	manager, stateDirectory, now := newStartupTempCleanupManager(t)
	operationsDirectory := filepath.Join(stateDirectory, "operations")
	recoveriesDirectory := filepath.Join(manager.Root, "recoveries")
	operationResidue := filepath.Join(operationsDirectory, ".tmp-101")
	recoveryResidue := filepath.Join(recoveriesDirectory, ".tmp-202")
	writeStartupTempResidue(t, operationResidue)
	writeStartupTempResidue(t, recoveryResidue)
	old := now.Add(-time.Duration(contract.ObsoleteArtifactRetentionSeconds+1) * time.Second)
	if err := os.Chtimes(recoveryResidue, old, old); err != nil {
		t.Fatal(err)
	}
	if err := manager.cleanupStartupAtomicResidues(); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{operationResidue, recoveryResidue} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("startup residue %s stat = %v, want removed", path, err)
		}
	}
}

func TestCleanupStartupAtomicResiduesKeepsFreshWatchdogDomainTempFailClosed(t *testing.T) {
	manager, _, now := newStartupTempCleanupManager(t)
	residue := filepath.Join(manager.Root, "recoveries", ".tmp-303")
	writeStartupTempResidue(t, residue)
	if err := os.Chtimes(residue, now, now); err != nil {
		t.Fatal(err)
	}
	err := manager.cleanupStartupAtomicResidues()
	if err == nil || !strings.Contains(err.Error(), "retained 1 fresh artifacts") {
		t.Fatalf("cleanup error = %v, want fresh-residue startup fence", err)
	}
	if _, err := os.Lstat(residue); err != nil {
		t.Fatalf("fresh watchdog-domain residue was removed: %v", err)
	}
}

func TestCleanupStartupAtomicResiduesRejectsDurableTempReference(t *testing.T) {
	manager, _, now := newStartupTempCleanupManager(t)
	state := State{
		SchemaVersion: 1,
		Current: &Version{
			Version: "current", Path: filepath.Join(manager.Root, "versions", "current", ".tmp-404"),
		},
		UpdatedAt: now,
	}
	if err := atomicfile.WriteJSON(manager.StatePath, state, 0o600); err != nil {
		t.Fatal(err)
	}
	err := manager.cleanupStartupAtomicResidues()
	if err == nil || !strings.Contains(err.Error(), "durable reference") {
		t.Fatalf("cleanup error = %v, want durable-reference rejection", err)
	}
}

func TestCleanupStartupAtomicResiduesCleansReferencedVersionDirectory(t *testing.T) {
	manager, _, now := newStartupTempCleanupManager(t)
	digest := strings.Repeat("a", 64)
	versionDirectory := filepath.Join(manager.Root, "versions", "running-"+digest[:12])
	if err := os.MkdirAll(versionDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	residue := filepath.Join(versionDirectory, ".tmp-505")
	writeStartupTempResidue(t, residue)
	state := State{
		SchemaVersion: 1,
		Current: &Version{
			Version: "current", Path: filepath.Join(versionDirectory, "ubitech-manager"), SHA256: digest,
		},
		UpdatedAt: now,
	}
	if err := atomicfile.WriteJSON(manager.StatePath, state, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := manager.cleanupStartupAtomicResidues(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(residue); !os.IsNotExist(err) {
		t.Fatalf("version residue stat = %v, want removed", err)
	}
}

func TestAcquireStartupOwnershipDoesNotScanUnrelatedFreshTempDomains(t *testing.T) {
	fixture := newStartupOwnershipFixture(t)
	activations := filepath.Join(fixture.manager.Root, "activations")
	paths := []string{
		filepath.Join(fixture.stateDir, ".tmp-909"),
		filepath.Join(activations, ".tmp-1000"),
		filepath.Join(activations, ".tmp-lookalike"),
	}
	for _, path := range paths {
		writeStartupTempResidue(t, path)
	}
	lease, err := fixture.manager.AcquireStartupOwnership()
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	for _, path := range paths {
		if _, err := os.Lstat(path); err != nil {
			t.Fatalf("noncritical startup residue %s was modified: %v", path, err)
		}
	}
}

func TestAcquireStartupOwnershipRemovesFreshOperationCrashResidue(t *testing.T) {
	fixture := newStartupOwnershipFixture(t)
	residue := filepath.Join(fixture.stateDir, "operations", ".tmp-606")
	writeStartupTempResidue(t, residue)
	lease, err := fixture.manager.AcquireStartupOwnership()
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	if _, err := os.Lstat(residue); !os.IsNotExist(err) {
		t.Fatalf("operation residue stat = %v, want removed before journal enumeration", err)
	}
}

func TestAcquireStartupOwnershipRemovesExpiredRecoveryCrashResidue(t *testing.T) {
	fixture := newStartupOwnershipFixture(t)
	directory := filepath.Join(fixture.manager.Root, "recoveries")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	residue := filepath.Join(directory, ".tmp-707")
	writeStartupTempResidue(t, residue)
	old := time.Now().UTC().Add(-time.Duration(contract.ObsoleteArtifactRetentionSeconds+1) * time.Second)
	if err := os.Chtimes(residue, old, old); err != nil {
		t.Fatal(err)
	}
	lease, err := fixture.manager.AcquireStartupOwnership()
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	if _, err := os.Lstat(residue); !os.IsNotExist(err) {
		t.Fatalf("recovery residue stat = %v, want removed before recovery enumeration", err)
	}
}

func TestAcquireStartupOwnershipRetainsFreshRecoveryTempFailClosed(t *testing.T) {
	fixture := newStartupOwnershipFixture(t)
	directory := filepath.Join(fixture.manager.Root, "recoveries")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	residue := filepath.Join(directory, ".tmp-808")
	writeStartupTempResidue(t, residue)
	lease, err := fixture.manager.AcquireStartupOwnership()
	if lease != nil {
		lease.Release()
	}
	if err == nil || !strings.Contains(err.Error(), "retained 1 fresh artifacts") {
		t.Fatalf("startup error = %v, want fresh recovery temp fence", err)
	}
	if _, err := os.Lstat(residue); err != nil {
		t.Fatalf("fresh recovery temp was removed: %v", err)
	}
}

func TestAcquireStartupOwnershipNeverUsesDurableVersionPathAsCleanupAuthority(t *testing.T) {
	for _, field := range []string{"current", "previous", "candidate"} {
		t.Run(field, func(t *testing.T) {
			fixture := newStartupOwnershipFixture(t)
			outsideParent := t.TempDir()
			outsideDirectory := filepath.Join(outsideParent, filepath.Base(filepath.Dir(fixture.current.Path)))
			if err := os.Mkdir(outsideDirectory, 0o700); err != nil {
				t.Fatal(err)
			}
			residue := filepath.Join(outsideDirectory, ".tmp-1212")
			writeStartupTempResidue(t, residue)
			outsideVersion := fixture.current
			outsideVersion.Path = filepath.Join(outsideDirectory, "ubitech-manager")
			state := State{SchemaVersion: 1, Current: &fixture.current, UpdatedAt: fixture.current.VerifiedAt}
			switch field {
			case "current":
				state.Current = &outsideVersion
			case "previous":
				state.Previous = &outsideVersion
			case "candidate":
				state.Candidate = &outsideVersion
			}
			writeStartupJSON(t, fixture.statePath, state)
			lease, err := fixture.manager.AcquireStartupOwnership()
			if lease != nil {
				lease.Release()
			}
			if err == nil || !strings.Contains(err.Error(), "outside the fixed versions root") {
				t.Fatalf("startup error = %v, want fixed-root rejection", err)
			}
			if _, err := os.Lstat(residue); err != nil {
				t.Fatalf("outside-root residue was modified: %v", err)
			}
		})
	}
}

func TestAcquireStartupOwnershipCleansFreshReferencedVersionResidue(t *testing.T) {
	fixture := newStartupOwnershipFixture(t)
	residue := filepath.Join(filepath.Dir(fixture.current.Path), ".tmp-1313")
	writeStartupTempResidue(t, residue)
	lease, err := fixture.manager.AcquireStartupOwnership()
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	if _, err := os.Lstat(residue); !os.IsNotExist(err) {
		t.Fatalf("referenced version residue stat = %v, want removed", err)
	}
}

func TestPruneVersionsCleansFreshAtomicResidueUnderRecoveryLock(t *testing.T) {
	manager, _, _, _ := newPreparedManager(t)
	state, err := manager.State()
	if err != nil || state.Candidate == nil {
		t.Fatalf("load prepared candidate: %#v %v", state, err)
	}
	residue := filepath.Join(filepath.Dir(state.Candidate.Path), ".tmp-1111")
	writeStartupTempResidue(t, residue)
	activations := filepath.Join(manager.Root, "activations")
	if err := os.MkdirAll(activations, 0o700); err != nil {
		t.Fatal(err)
	}
	agedResidue := filepath.Join(activations, ".tmp-2222")
	freshResidue := filepath.Join(activations, ".tmp-3333")
	writeStartupTempResidue(t, agedResidue)
	writeStartupTempResidue(t, freshResidue)
	now := time.Now().UTC()
	old := now.Add(-2 * time.Hour)
	if err := os.Chtimes(agedResidue, old, old); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.PruneVersions(context.Background(), now, time.Hour); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{residue, agedResidue} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("atomic residue %s stat = %v, want removed", path, err)
		}
	}
	if _, err := os.Lstat(freshResidue); err != nil {
		t.Fatalf("fresh watchdog-domain residue was removed: %v", err)
	}
}

func TestPruneVersionsRejectsAtomicLookalikeWithoutRemovingIt(t *testing.T) {
	manager, _, _, _ := newPreparedManager(t)
	state, err := manager.State()
	if err != nil || state.Candidate == nil {
		t.Fatalf("load prepared candidate: %#v %v", state, err)
	}
	lookalike := filepath.Join(filepath.Dir(state.Candidate.Path), ".tmp-attacker")
	writeStartupTempResidue(t, lookalike)
	_, err = manager.PruneVersions(context.Background(), time.Now().UTC(), time.Hour)
	if err == nil || !strings.Contains(err.Error(), "unknown atomic temporary") {
		t.Fatalf("version maintenance error = %v, want lookalike rejection", err)
	}
	if _, err := os.Lstat(lookalike); err != nil {
		t.Fatalf("version lookalike was removed: %v", err)
	}
}

func newStartupTempCleanupManager(t *testing.T) (*Manager, string, time.Time) {
	t.Helper()
	stateDirectory := t.TempDir()
	root := filepath.Join(stateDirectory, "manager-binaries")
	for _, directory := range []string{
		root,
		filepath.Join(root, "versions"),
		filepath.Join(root, "activations"),
		filepath.Join(root, "recoveries"),
		filepath.Join(stateDirectory, "operations"),
	} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Unix(2_000_000_000, 0).UTC()
	manager := &Manager{Profile: testActiveProfile,
		Root:             root,
		StatePath:        filepath.Join(stateDirectory, "manager-binaries.json"),
		InstallPath:      filepath.Join(stateDirectory, "bin", "ubitech-manager"),
		SocketPath:       filepath.Join(stateDirectory, "control", "manager.sock"),
		ControlTokenFile: filepath.Join(stateDirectory, "secrets", "manager-token"),
		Now:              func() time.Time { return now },
	}
	return manager, stateDirectory, now
}

func writeStartupTempResidue(t *testing.T, path string) {
	t.Helper()
	if err := os.WriteFile(path, []byte("crash residue"), 0o600); err != nil {
		t.Fatal(err)
	}
}
