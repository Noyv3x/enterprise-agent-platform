package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDefaultsKeepLANClosedOnLoopback(t *testing.T) {
	cfg, err := Defaults()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LANEnabled || cfg.LANAddress != "127.0.0.1:8081" {
		t.Fatalf("unsafe LAN defaults: %#v", cfg)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestLoadStandardManagerConfig(t *testing.T) {
	root := filepath.Join(t.TempDir(), "data root")
	path := filepath.Join(t.TempDir(), "manager.toml")
	content := "data_root = \"" + root + "\"\nlisten = \"127.0.0.1:19090\"\nlan_enabled = true\nlan_listen = \"192.168.10.5:19091\"\ndirect_access_cidrs = [\"10.10.0.0/16\", \"fd12::/16\"]\ntrusted_ingress_cidrs = [\"127.0.0.0/8\"]\nrelease_manifest_url = \"https://releases.example/main.json\"\nrelease_channel = \"main\"\nupdate_enabled = true\nupdate_interval = \"7m\"\nsandbox_idle = \"45m\"\nlog_max_size = \"20MiB\"\nlog_max_files = 7\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DataRoot != root || cfg.PlatformDataDir() != filepath.Join(root, "data") || cfg.StateDir != filepath.Join(root, "manager") {
		t.Fatalf("unexpected derived paths: %#v", cfg)
	}
	if cfg.SocketPath != filepath.Join(root, "manager", "control", "manager.sock") {
		t.Fatalf("unexpected socket: %s", cfg.SocketPath)
	}
	if cfg.UpdateInterval != 7*time.Minute || cfg.SandboxIdle != 45*time.Minute || cfg.LogMaxBytes != 20<<20 || cfg.LogBackups != 7 {
		t.Fatalf("standard values were not parsed: %#v", cfg)
	}
	if !cfg.LANEnabled || cfg.LANAddress != "192.168.10.5:19091" || len(cfg.DirectAccessCIDRs) != 2 || cfg.DirectAccessCIDRs[0] != "10.10.0.0/16" {
		t.Fatalf("LAN values were not parsed: %#v", cfg)
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

func TestLoadRejectsPlaintextManagerToken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "manager.toml")
	if err := os.WriteFile(path, []byte("internal_token = \"do-not-store-this-here\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("plaintext Manager token was accepted")
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
	cfg.SocketPath = filepath.Join(cfg.StateDir, "control", "custom.sock")
	cfg.PlatformURL = "http://127.0.0.1:2222"
	cfg.PlatformGateURL = "http://127.0.0.1:3333"
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
	if loaded.SocketPath != cfg.SocketPath || loaded.PlatformURL != cfg.PlatformURL || loaded.PlatformGateURL != cfg.PlatformGateURL || loaded.ComposeFile != cfg.ComposeFile || loaded.SandboxNetwork != cfg.SandboxNetwork || loaded.InternalTokenFile != cfg.InternalTokenFile {
		t.Fatalf("private settings were lost: %#v", loaded)
	}
}

func TestLANConfigRejectsBroadOrConflictingAccess(t *testing.T) {
	t.Parallel()
	base, err := Defaults()
	if err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*Config){
		"public direct CIDR":     func(cfg *Config) { cfg.DirectAccessCIDRs = []string{"0.0.0.0/0"} },
		"non-canonical CIDR":     func(cfg *Config) { cfg.DirectAccessCIDRs = []string{"192.168.1.1/24"} },
		"public trusted ingress": func(cfg *Config) { cfg.TrustedIngressCIDRs = []string{"203.0.113.0/24"} },
		"hostname listen":        func(cfg *Config) { cfg.LANAddress = "lan.example:8081" },
		"public bind":            func(cfg *Config) { cfg.LANAddress = "203.0.113.10:8081" },
		"wildcard bind":          func(cfg *Config) { cfg.LANAddress = "0.0.0.0:8081" },
		"overlapping listeners":  func(cfg *Config) { cfg.LANEnabled = true; cfg.LANAddress = "127.0.0.1:8080" },
	} {
		t.Run(name, func(t *testing.T) {
			cfg := base
			cfg.DirectAccessCIDRs = append([]string(nil), base.DirectAccessCIDRs...)
			cfg.TrustedIngressCIDRs = append([]string(nil), base.TrustedIngressCIDRs...)
			mutate(&cfg)
			if err := cfg.Validate(); err == nil {
				t.Fatal("invalid LAN configuration was accepted")
			}
		})
	}
}

func TestPatchPersistsLANConfiguration(t *testing.T) {
	root := t.TempDir()
	cfg, err := Defaults()
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConfigPath = filepath.Join(root, "manager.toml")
	cfg.DataRoot = filepath.Join(root, "data")
	cfg.StateDir = filepath.Join(cfg.DataRoot, "manager")
	cfg.SocketPath = filepath.Join(cfg.StateDir, "control", "manager.sock")
	manager := NewManager(cfg)
	enabled := true
	listen := "192.168.20.5:8091"
	direct := []string{"192.168.20.0/24"}
	trusted := []string{"127.0.0.0/8", "192.168.20.2/32"}
	updated, err := manager.Patch(Patch{LANEnabled: &enabled, LANListen: &listen, DirectAccessCIDRs: &direct, TrustedIngressCIDRs: &trusted})
	if err != nil {
		t.Fatal(err)
	}
	if !updated.LANEnabled || updated.LANListen != listen || len(updated.DirectAccessCIDRs) != 1 {
		t.Fatalf("public LAN config = %#v", updated)
	}
	loaded, err := Load(cfg.ConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	if !loaded.LANEnabled || loaded.LANAddress != listen || len(loaded.TrustedIngressCIDRs) != 2 {
		t.Fatalf("persisted LAN config = %#v", loaded)
	}
}
