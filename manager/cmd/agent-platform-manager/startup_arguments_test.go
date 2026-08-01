package main

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestParseStartupArgumentsAcceptsTargetCommandShapes(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "manager.toml")
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
		{"self-update-watchdog", []string{"--config", configPath, "--plan", planPath}},
		{"recover-current", []string{"--config", configPath, "--expected-sha256", strings.Repeat("a", 64), "--yes"}},
	}
	for _, test := range tests {
		t.Run(test.command, func(t *testing.T) {
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

func TestParseStartupArgumentsFailsClosedBeforeStateRead(t *testing.T) {
	absolute := filepath.Join(t.TempDir(), "manager.toml")
	tests := []struct {
		name    string
		command string
		args    []string
	}{
		{"unknown command", "unknown", nil},
		{"unknown option", "status", []string{"--config", absolute, "--profile", "target"}},
		{"duplicate config", "status", []string{"--config", absolute, "--config=" + absolute}},
		{"relative config", "status", []string{"--config", "relative.toml"}},
		{"unclean config", "status", []string{"--config", filepath.Dir(absolute) + "/x/../manager.toml"}},
		{"relative plan", "self-update-watchdog", []string{"--config", absolute, "--plan", "plan.json"}},
		{"missing watchdog config", "self-update-watchdog", []string{"--plan", filepath.Join(t.TempDir(), "plan.json")}},
		{"missing recovery config", "recover-current", []string{"--yes", "--expected-sha256", strings.Repeat("a", 64)}},
		{"false recovery confirmation", "recover-current", []string{"--config", absolute, "--yes=false", "--expected-sha256", strings.Repeat("a", 64)}},
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
