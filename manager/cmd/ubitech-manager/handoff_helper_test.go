//go:build linux

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/config"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffhost"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

func TestHandoffHelperParserIsClosedWorld(t *testing.T) {
	tx := "/state/agent-platform/handoff/handoff_0123456789abcdef0123456789abcdef"
	valid := []string{"--listener-socket", filepath.Join(tx, "source-to-helper.listeners.sock"), "--transaction", filepath.Base(tx), "--journal", filepath.Join(tx, "journal.json")}
	parsed, err := parseHandoffHelperArguments(valid)
	if err != nil || parsed.transactionDirectory != tx {
		t.Fatalf("parse valid helper argv = %+v, %v", parsed, err)
	}
	for name, arguments := range map[string][]string{
		"unknown":    append(append([]string(nil), valid[:4]...), "--other", filepath.Join(tx, "journal.json")),
		"duplicate":  []string{"--transaction", filepath.Base(tx), "--transaction", filepath.Base(tx), "--journal", filepath.Join(tx, "journal.json")},
		"positional": append(append([]string(nil), valid...), "extra"),
		"equals":     []string{"--transaction=" + filepath.Base(tx), "x", "--journal", filepath.Join(tx, "journal.json"), "--listener-socket", filepath.Join(tx, "source-to-helper.listeners.sock")},
		"mismatch":   []string{"--transaction", filepath.Base(tx), "--journal", filepath.Join(tx, "journal.json"), "--listener-socket", filepath.Join(tx, "other.sock")},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseHandoffHelperArguments(arguments); err == nil {
				t.Fatal("expected closed-world helper argv rejection")
			}
		})
	}
}

func TestRunRoutesHelperBeforeOrdinaryStartup(t *testing.T) {
	original := executeHandoffHelper
	defer func() { executeHandoffHelper = original }()
	want := []string{"--unknown"}
	called := false
	executeHandoffHelper = func(arguments []string) error {
		called = true
		if !reflect.DeepEqual(arguments, want) {
			t.Fatalf("helper arguments = %v", arguments)
		}
		return nil
	}
	if code := run(append([]string{handoffhost.HelperSubcommand}, want...)); code != 0 || !called {
		t.Fatalf("helper route code=%d called=%v", code, called)
	}
}

func TestHandoffHelperIgnoresAmbientLocator(t *testing.T) {
	t.Setenv(handoffTransactionEnvironment, "/attacker/locator")
	err := handoffHelperCommand([]string{"--unknown"})
	if err == nil || os.Getenv(handoffTransactionEnvironment) != "" {
		t.Fatalf("helper locator isolation error=%v env=%q", err, os.Getenv(handoffTransactionEnvironment))
	}
}

func TestHelperBindingsUseJournalCustomSourceDataRoot(t *testing.T) {
	root := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "config"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(root, "data-home"))
	t.Setenv("XDG_STATE_HOME", filepath.Join(root, "state-home"))
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(root, "runtime"))
	for _, directory := range []string{os.Getenv("XDG_CONFIG_HOME"), os.Getenv("XDG_DATA_HOME"), os.Getenv("XDG_STATE_HOME"), os.Getenv("XDG_RUNTIME_DIR")} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	sourceActive := identity.SourceActiveProfile()
	sourceDefaults, err := config.Defaults(sourceActive)
	if err != nil {
		t.Fatal(err)
	}
	customRoot := filepath.Join(root, "custom", identity.SourceProfile().DataDirectory)
	if err := os.MkdirAll(filepath.Dir(sourceDefaults.ConfigPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sourceDefaults.ConfigPath, []byte("data_root = \""+customRoot+"\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	source, err := config.Load(sourceActive, sourceDefaults.ConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	targetActive, _ := identity.ActivateVerifiedHandoffTarget(identity.TargetProfile())
	targetConfigPath := identity.TargetProfile().DefaultConfigPath(os.Getenv("XDG_CONFIG_HOME"))
	targetRoot := identity.TargetProfile().DefaultDataRoot(os.Getenv("XDG_DATA_HOME"))
	targetSocket := filepath.Join(os.Getenv("XDG_RUNTIME_DIR"), filepath.FromSlash(identity.TargetProfile().RuntimeSocketPath))
	target, err := config.DeriveHandoffTarget(source, targetActive, targetConfigPath, targetRoot, targetSocket)
	if err != nil {
		t.Fatal(err)
	}
	targetRaw, err := config.RenderHandoffTarget(target)
	if err != nil {
		t.Fatal(err)
	}
	targetDigest := sha256.Sum256(targetRaw)
	sourceRaw, err := os.ReadFile(source.ConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	hydratedSource := source
	hydratedSource.InternalToken = "runtime-only-secret"
	rendered, err := (sourceTargetConfigRenderer{source: hydratedSource}).RenderTargetConfig(
		source.ConfigPath, sourceRaw, targetConfigPath, targetRoot, targetSocket,
	)
	if err != nil || !reflect.DeepEqual(rendered, targetRaw) {
		t.Fatalf("render target from retained source snapshot = %q, %v", rendered, err)
	}
	digest, err := secureConfigSHA256(source.ConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	journal := handoff.Journal{
		Source: handoff.SourceBinding{
			ConfigPath: source.ConfigPath, ConfigSHA256: digest, DataRoot: customRoot, SocketPath: source.SocketPath,
			StableBinary:   filepath.Join(root, "bin", identity.SourceProfile().ManagerBinary),
			ComposeProject: identity.SourceProfile().ComposeProject, CoreNetwork: identity.SourceProfile().CoreNetwork,
		},
		Target: handoff.TargetBinding{
			ConfigPath: target.ConfigPath, ConfigSHA256: hex.EncodeToString(targetDigest[:]), DataRoot: target.DataRoot, SocketPath: target.SocketPath,
			StableBinary:   filepath.Join(root, "bin", identity.TargetProfile().ManagerBinary),
			ComposeProject: identity.TargetProfile().ComposeProject, CoreNetwork: identity.TargetProfile().CoreNetwork,
		},
	}
	bindings, err := helperBindingsFromJournal(journal, source, target, digest)
	if err != nil {
		t.Fatal(err)
	}
	if bindings.Source.DataRoot != customRoot || bindings.Source.StateRoot != identity.SourceProfile().ManagerStateRoot(customRoot) ||
		strings.Contains(bindings.Source.DataRoot, os.Getenv("XDG_DATA_HOME")+string(filepath.Separator)+identity.SourceProfile().DataDirectory) {
		t.Fatalf("helper source binding ignored custom root: %+v", bindings.Source)
	}
	journal.Target.ConfigSHA256 = strings.Repeat("f", 64)
	if _, err := helperBindingsFromJournal(journal, source, target, digest); err == nil || !strings.Contains(err.Error(), "target configuration digest") {
		t.Fatalf("mismatched target config digest error = %v", err)
	}
}
