package selfupdate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
)

func TestBridgeUnitRejectsAmbiguousCommandOwnership(t *testing.T) {
	stable, launcher, config := "/private/bin/manager", "/private/state/launcher", "/private/config/manager.toml"
	base := "[Service]\nExecStart=" + stable + " serve --config " + config + "\nRestart=on-failure\n"
	for name, unit := range map[string]string{
		"different config":  strings.Replace(base, config, "/other/manager.toml", 1),
		"extra argument":    strings.Replace(base, "\nRestart", " --plan /other/plan\nRestart", 1),
		"duplicate command": base + "ExecStart=/usr/bin/true\n",
		"wrong section":     strings.Replace(base, "[Service]", "[Unit]", 1),
		"restart override":  base + "Restart=always\n",
		"commented policy":  strings.Replace(base, "Restart=", "#Restart=", 1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := bridgeUnit([]byte(unit), stable, launcher, config); err == nil {
				t.Fatal("accepted a unit that does not exclusively own the bound Manager command")
			}
		})
	}
	for _, unsafe := range []string{"relative/launcher", "/private/%u/launcher", "/private/$HOME/launcher", "/private/launcher\nExecStart=/usr/bin/false"} {
		if _, err := bridgeUnit([]byte(base), stable, unsafe, config); err == nil {
			t.Fatalf("accepted unsafe launcher path %q", unsafe)
		}
	}
}

func TestReadBridgeUnitAllowsStandardUserDirectoryButProtectsUnit(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "manager.service")
	unit := "[Service]\nExecStart=/usr/bin/true\n"
	if err := os.WriteFile(path, []byte(unit), 0o600); err != nil {
		t.Fatal(err)
	}
	data, err := readBridgePrivateFile(path)
	if err != nil || string(data) != unit {
		t.Fatalf("private unit in standard user directory: %q %v", data, err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readBridgePrivateFile(path); err == nil {
		t.Fatal("accepted a publicly readable unit")
	}
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "linked.service")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := readBridgePrivateFile(link); err == nil {
		t.Fatal("accepted a symlink unit")
	}
	if err := os.Chmod(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	if _, err := readBridgePrivateFile(path); err == nil {
		t.Fatal("accepted a replaceable unit directory")
	}
}

func TestBridgeConfigAllowsLegacyDirectoryPermissions(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "manager.toml")
	config := "data_root = \"/private/platform\"\n"
	if err := os.WriteFile(path, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	data, err := readBridgePrivateFile(path)
	if err != nil || string(data) != config {
		t.Fatalf("legacy private configuration cannot cross handoff: %q %v", data, err)
	}
}

func TestBridgeCheckpointRestrictsInterruptedUnitMutation(t *testing.T) {
	record := bridgeHandoff{Original: []byte("original unit"), Replacement: []byte("launcher unit")}
	for _, test := range []struct {
		phase   string
		actual  []byte
		allowed bool
	}{
		{"prepared", record.Original, true},
		{"prepared", record.Replacement, false},
		{"switching", record.Original, true},
		{"switching", record.Replacement, true},
		{"recovering", record.Original, true},
		{"recovering", record.Replacement, true},
		{"switching", []byte("unrelated administrator unit"), false},
		{"unknown", record.Original, false},
	} {
		record.Status = test.phase
		if err := validateBridgeCheckpoint(record, test.actual); (err == nil) != test.allowed {
			t.Fatalf("phase=%s actual=%q allowed=%v error=%v", test.phase, test.actual, test.allowed, err)
		}
	}
}

func TestBridgeExplicitRetryRequiresRecoveredFailedCheckpoint(t *testing.T) {
	record := bridgeHandoff{Status: "failed", Original: []byte("original unit"), Replacement: []byte("launcher unit")}
	if err := validateBridgeRetry(record, record.Original, false); err != nil {
		t.Fatalf("recovered failure cannot be explicitly retried: %v", err)
	}
	if err := validateBridgeRetry(record, record.Replacement, false); err == nil {
		t.Fatal("retry accepted an unrecovered launcher unit")
	}
	if err := validateBridgeRetry(record, record.Original, true); err == nil {
		t.Fatal("retry accepted a proven launcher")
	}
	for _, phase := range []string{"prepared", "switching", "recovering", "proven"} {
		record.Status = phase
		if err := validateBridgeRetry(record, record.Original, false); err == nil {
			t.Fatalf("retry crossed %s handoff ownership", phase)
		}
	}
}

func TestBridgeCatalogCandidateDoesNotOwnOperationAdmission(t *testing.T) {
	state := model.ManagerState{SchemaVersion: 1, Current: &model.Generation{ID: strings.Repeat("a", 40)}, Candidate: &model.Generation{ID: strings.Repeat("b", 40)}}
	if err := bridgePlatformSettled(state); err != nil {
		t.Fatalf("catalog-only check blocked settled handoff: %v", err)
	}
	for _, owner := range []string{"active", "finalize", "maintenance"} {
		owned := state
		switch owner {
		case "active":
			owned.ActiveOperationID = "op_original"
		case "finalize":
			owned.FinalizePendingOperationID = "op_original"
		case "maintenance":
			owned.Maintenance = true
		}
		if err := bridgePlatformSettled(owned); err == nil {
			t.Fatalf("%s ownership crossed handoff admission", owner)
		}
	}
}

func TestBridgeAdmissionWaitsForBothDurableProofCheckpoints(t *testing.T) {
	manager := &Manager{Root: t.TempDir()}
	if err := os.Chmod(manager.Root, 0o700); err != nil {
		t.Fatal(err)
	}
	immutable := Version{Path: filepath.Join(manager.Root, "launcher"), Version: strings.Repeat("a", 40), SHA256: strings.Repeat("b", 64)}
	launcher := launcherState{SchemaVersion: 1, Launcher: immutable, Proven: true}
	record := bridgeHandoff{Status: "switching", Launcher: immutable}
	if err := atomicfile.WriteJSON(manager.launcherPath(), launcher, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := atomicfile.WriteJSON(manager.bridgeHandoffPath(), record, 0o600); err != nil {
		t.Fatal(err)
	}
	if ready, err := manager.BridgeAdmissionReady(); err != nil || ready {
		t.Fatalf("proof-before-terminal crash admitted a stable replacement: ready=%v err=%v", ready, err)
	}
	record.Status = "proven"
	if err := atomicfile.WriteJSON(manager.bridgeHandoffPath(), record, 0o600); err != nil {
		t.Fatal(err)
	}
	if ready, err := manager.BridgeAdmissionReady(); err != nil || !ready {
		t.Fatalf("both settled checkpoints did not admit operations: ready=%v err=%v", ready, err)
	}
	launcher.Proven = false
	if err := atomicfile.WriteJSON(manager.launcherPath(), launcher, 0o600); err != nil {
		t.Fatal(err)
	}
	if ready, err := manager.BridgeAdmissionReady(); err != nil || ready {
		t.Fatalf("handoff record alone admitted operations: ready=%v err=%v", ready, err)
	}
}
