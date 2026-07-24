package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLoadStandardManagerConfig(t *testing.T) {
	root := filepath.Join(t.TempDir(), "data root")
	path := filepath.Join(t.TempDir(), "manager.toml")
	content := "data_root = \"" + root + "\"\nlisten = \"127.0.0.1:19090\"\nrelease_manifest_url = \"https://releases.example/main.json\"\nrelease_channel = \"main\"\nupdate_enabled = true\nupdate_interval = \"7m\"\nsandbox_idle = \"45m\"\nlog_max_size = \"20MiB\"\nlog_max_files = 7\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DataRoot != root || cfg.DataDir != filepath.Join(root, "data") || cfg.StateDir != filepath.Join(root, "manager") {
		t.Fatalf("unexpected derived paths: %#v", cfg)
	}
	if cfg.SocketPath != filepath.Join(root, "manager", "control", "manager.sock") {
		t.Fatalf("unexpected socket: %s", cfg.SocketPath)
	}
	if cfg.UpdateInterval != 7*time.Minute || cfg.SandboxIdle != 45*time.Minute || cfg.LogMaxBytes != 20<<20 || cfg.LogBackups != 7 {
		t.Fatalf("standard values were not parsed: %#v", cfg)
	}
}
func TestLoadRejectsUnknownSetting(t *testing.T) {
	path := filepath.Join(t.TempDir(), "manager.toml")
	if err := os.WriteFile(path, []byte("unknown = \"value\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("expected unknown setting rejection")
	}
}

func TestLoadAcceptsOnlyCanonicalCompatibilityDataDir(t *testing.T) {
	root := filepath.Join(t.TempDir(), "data-root")
	path := filepath.Join(t.TempDir(), "manager.toml")
	canonical := filepath.Join(root, "data")
	if err := os.WriteFile(path, []byte("data_root = \""+root+"\"\ndata_dir = \""+canonical+"/\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("canonical compatibility data_dir was rejected: %v", err)
	}
	if cfg.PlatformDataDir() != canonical || filepath.Clean(cfg.DataDir) != canonical {
		t.Fatalf("canonical data directory diverged: %#v", cfg)
	}

	detached := filepath.Join(t.TempDir(), "detached-data")
	for name, content := range map[string]string{
		"after data_root":  "data_root = \"" + root + "\"\ndata_dir = \"" + detached + "\"\n",
		"before data_root": "data_dir = \"" + detached + "\"\ndata_root = \"" + root + "\"\n",
	} {
		t.Run(name, func(t *testing.T) {
			if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := Load(path); err == nil || !strings.Contains(err.Error(), "data_dir must equal data_root/data") {
				t.Fatalf("divergent data_dir was not rejected: %v", err)
			}
		})
	}
}

func TestLoadRejectsPlaintextManagerToken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "manager.toml")
	if err := os.WriteFile(path, []byte("internal_token = \"do-not-store-this-here\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("plaintext Manager token was accepted")
	}
}

func TestValidateSourceMigrationUsesEffectiveParsedConfiguration(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, "manager.toml")
	dataRoot := filepath.Join(root, "data")
	content := "data_root = \"" + dataRoot + "/\"\n" +
		"listen = \"127.0.0.1:8765\"\n" +
		"release_manifest_url = \"https://releases.example/main.json\"\n" +
		"release_channel = \"main\"\n" +
		"legacy_platform_gate_url = \"http://127.0.0.1:18765\"\n"
	if err := os.WriteFile(configPath, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	expected := SourceMigrationExpectations{
		DataRoot:           dataRoot,
		GatewayAddress:     "127.0.0.1:8765",
		ReleaseManifestURL: "https://releases.example/main.json",
		ReleaseChannel:     "main",
		LegacyPlatformURL:  "http://127.0.0.1:18765",
		ControlSocketPath:  filepath.Join(dataRoot, "manager", "control", "manager.sock"),
	}
	if err := cfg.ValidateSourceMigration(expected); err != nil {
		t.Fatal(err)
	}
}

func TestValidateSourceMigrationRejectsMismatchAndIncompleteExpectations(t *testing.T) {
	cfg, err := Defaults()
	if err != nil {
		t.Fatal(err)
	}
	expected := SourceMigrationExpectations{
		DataRoot:           cfg.DataRoot,
		GatewayAddress:     cfg.GatewayAddress,
		ReleaseManifestURL: "https://releases.example/main.json",
		ReleaseChannel:     cfg.ReleaseChannel,
		LegacyPlatformURL:  "http://127.0.0.1:18765",
		ControlSocketPath:  cfg.SocketPath,
	}
	cfg.ReleaseURL = expected.ReleaseManifestURL
	cfg.LegacyPlatformGateURL = expected.LegacyPlatformURL

	mismatched := expected
	mismatched.GatewayAddress = "127.0.0.1:9999"
	if err := cfg.ValidateSourceMigration(mismatched); err == nil || !strings.Contains(err.Error(), "mismatch for listen") {
		t.Fatalf("expected listener mismatch, got %v", err)
	}
	incomplete := expected
	incomplete.ControlSocketPath = ""
	if err := cfg.ValidateSourceMigration(incomplete); err == nil || !strings.Contains(err.Error(), "socket_path is required") {
		t.Fatalf("expected missing socket requirement, got %v", err)
	}
}

func TestPatchPreservesPrivateManagerSettings(t *testing.T) {
	root := t.TempDir()
	cfg, err := Defaults()
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConfigPath = filepath.Join(root, "manager.toml")
	cfg.DataRoot = filepath.Join(root, "data-root")
	cfg.StateDir = filepath.Join(cfg.DataRoot, "manager")
	cfg.DataDir = filepath.Join(cfg.DataRoot, "data")
	cfg.SocketPath = filepath.Join(cfg.StateDir, "control", "custom.sock")
	cfg.PlatformURL = "http://127.0.0.1:2222"
	cfg.PlatformGateURL = "http://127.0.0.1:3333"
	cfg.LegacyPlatformGateURL = "http://127.0.0.1:4444"
	cfg.InternalTokenFile = filepath.Join(cfg.StateDir, "secrets", "manager-token")
	if err := os.MkdirAll(filepath.Dir(cfg.InternalTokenFile), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfg.InternalTokenFile, []byte("01234567890123456789012345678901\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg.ComposeFile = filepath.Join(root, "compose.yaml")
	cfg.SandboxNetwork = "custom_core"
	manager := NewManager(cfg)
	enabled := false
	if _, err := manager.Patch(Patch{UpdateEnabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(cfg.ConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.SocketPath != cfg.SocketPath || loaded.PlatformURL != cfg.PlatformURL || loaded.PlatformGateURL != cfg.PlatformGateURL || loaded.LegacyPlatformGateURL != cfg.LegacyPlatformGateURL || loaded.ComposeFile != cfg.ComposeFile || loaded.SandboxNetwork != cfg.SandboxNetwork || loaded.InternalTokenFile != cfg.InternalTokenFile {
		t.Fatalf("private settings were lost: %#v", loaded)
	}
}
