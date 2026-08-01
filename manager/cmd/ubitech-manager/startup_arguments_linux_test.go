//go:build linux

package main

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestParseStartupArgumentsAcceptsClosedCommandShapes(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "custom", "manager.toml")
	planPath := filepath.Join(t.TempDir(), "activation.json")
	tests := []struct {
		command string
		args    []string
	}{
		{"serve", []string{"--config", configPath}},
		{"preflight", []string{"--config=" + configPath, "--probe-user-systemd-transient=false"}},
		{"install", []string{"-config", configPath, "--release-manifest-url", "https://example.invalid/release.json"}},
		{"status", []string{"--config", configPath}},
		{"check", []string{"--config", configPath, "--release-manifest-url=https://example.invalid/release.json"}},
		{"update", []string{"--config", configPath}},
		{"restart", []string{"--config", configPath}},
		{"rollback", []string{"--config", configPath}},
		{"repair", []string{"--config", configPath}},
		{"logs", []string{"--config", configPath, "--service", "platform", "--tail", "10"}},
		{"release-transition", []string{"identity", "--config", configPath, "--public-key-pem", "/tmp/key.pem"}},
		{"release-transition", []string{"attest", "--config", configPath, "--challenge", "/tmp/challenge", "--receipt", "/tmp/receipt", "--signature", "/tmp/signature"}},
		{"self-update-watchdog", []string{"--config", configPath, "--plan", planPath}},
		{"recover-current", []string{"--config", configPath, "--expected-sha256", strings.Repeat("a", 64), "--yes"}},
	}
	for _, test := range tests {
		t.Run(test.command+strings.Join(test.args, "_"), func(t *testing.T) {
			parsed, err := parseStartupArguments(test.command, test.args)
			if err != nil {
				t.Fatal(err)
			}
			if parsed.ConfigPath != configPath {
				t.Fatalf("config = %q, want %q", parsed.ConfigPath, configPath)
			}
		})
	}
}

func TestParseStartupArgumentsFailsClosedBeforeRouting(t *testing.T) {
	absolute := filepath.Join(t.TempDir(), "manager.toml")
	tests := []struct {
		name    string
		command string
		args    []string
	}{
		{"unknown command", "unknown", nil},
		{"unknown release subcommand", "release-transition", []string{"unknown"}},
		{"unknown option", "status", []string{"--config", absolute, "--profile", "target"}},
		{"duplicate long config", "status", []string{"--config", absolute, "--config=" + absolute}},
		{"duplicate short config", "serve", []string{"-config", absolute, "--config", absolute}},
		{"relative config", "status", []string{"--config", "relative.toml"}},
		{"unclean config", "status", []string{"--config", filepath.Dir(absolute) + "/x/../manager.toml"}},
		{"relative plan", "self-update-watchdog", []string{"--config", absolute, "--plan", "plan.json"}},
		{"missing recovery config", "recover-current", []string{"--yes", "--expected-sha256", strings.Repeat("a", 64)}},
		{"false recovery confirmation", "recover-current", []string{"--config", absolute, "--yes=false", "--expected-sha256", strings.Repeat("a", 64)}},
		{"missing watchdog plan", "self-update-watchdog", []string{"--config", absolute}},
		{"positional", "status", []string{"unexpected"}},
		{"terminator", "status", []string{"--", "--config", absolute}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := parseStartupArguments(test.command, test.args); err == nil {
				t.Fatal("invalid startup arguments were accepted")
			}
		})
	}
}
