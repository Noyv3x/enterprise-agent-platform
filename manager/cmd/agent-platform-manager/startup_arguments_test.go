package main

import (
	"path/filepath"
	"testing"
)

func TestParseStartupArgumentsAcceptsTargetCommandShapes(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "manager.toml")
	tests := []struct {
		command string
		args    []string
	}{
		{"serve", []string{"--config", configPath}},
		{"launcher", []string{"--config", configPath}},
		{"bootstrap-launcher", []string{"--config", configPath}},
		{"preflight", []string{"--config=" + configPath}},
		{"install", []string{"-config", configPath, "--release-manifest-url", "https://example.invalid/release.json"}},
		{"status", []string{"--config", configPath}},
		{"check", []string{"--config", configPath, "--release-manifest-url=https://example.invalid/release.json"}},
		{"update", []string{"--config", configPath}},
		{"restart", []string{"--config", configPath}},
		{"rollback", []string{"--config", configPath}},
		{"repair", []string{"--config", configPath}},
		{"logs", []string{"--config", configPath, "--service", "platform", "--tail", "10"}},
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
		{"retired watchdog", "self-update-watchdog", nil},
		{"retired recovery", "recover-current", nil},
		{"missing launcher config", "launcher", nil},
		{"missing bootstrap config", "bootstrap-launcher", nil},
		{"launcher command injection", "launcher", []string{"--config", absolute, "--plan", absolute}},
		{"launcher cannot retry handoff", "launcher", []string{"--config", absolute, "--retry"}},
		{"retired handoff", "bridge-handoff", nil},
		{"bootstrap cannot retry", "bootstrap-launcher", []string{"--config", absolute, "--retry"}},
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
