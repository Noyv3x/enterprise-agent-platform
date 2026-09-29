package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/selfupdate"
)

func bridgeCommand(command string, arguments []string) error {
	set, path := commonFlags(command)
	var retry bool
	if command == "bridge-handoff" {
		set.BoolVar(&retry, "retry", false, "retry a recovered failed launcher handoff")
	}
	if err := set.Parse(arguments); err != nil {
		return err
	}
	cfg, err := load(*path)
	if err != nil {
		return err
	}
	manager := &selfupdate.Manager{
		Profile: identity.CompileTimeActiveProfile(), ConfigPath: cfg.ConfigPath,
		Root: filepath.Join(cfg.StateDir, "manager-binaries"), StatePath: filepath.Join(cfg.StateDir, "manager-binaries.json"),
		InstallPath: managerInstallPath(), SocketPath: cfg.SocketPath, ControlTokenFile: cfg.ControlTokenFile(),
		UnitName: identity.TargetProfile().ManagerUnit, RunningVersion: version,
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if command == "launcher" {
		resumeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		err := manager.ResumeBridgeHandoff(resumeCtx)
		cancel()
		if err != nil {
			return fmt.Errorf("resume independent Manager handoff: %w", err)
		}
		// The child acknowledges only after operation recovery and core/public
		// readiness; the launcher independently authenticates its identity.
		err = manager.RunLauncher(ctx, nil)
		if errors.Is(err, selfupdate.ErrLauncherStopped) {
			fmt.Fprintf(os.Stderr, "Manager launcher stopped: %v\n", err)
			return nil
		}
		return err
	}
	if retry {
		retryCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
		defer cancel()
		return manager.RetryBridgeHandoff(retryCtx)
	}
	return manager.RunBridgeHandoff(ctx)
}

func (app *application) runBridgeHandoff(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		app.maintenanceMu.Lock()
		state := app.state.State()
		if state.Current == nil || state.ActiveOperationID != "" || state.FinalizePendingOperationID != "" || state.Maintenance || app.operations.RecoveryPending() {
			app.maintenanceMu.Unlock()
			continue
		}
		attempt, cancel := context.WithTimeout(ctx, 20*time.Second)
		err := app.selfUpdate.BeginBridgeHandoff(attempt)
		cancel()
		app.maintenanceMu.Unlock()
		if errors.Is(err, selfupdate.ErrBridgeNotReady) {
			continue
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "Manager launcher handoff: %v\n", err)
		}
		// The independent worker owns all switch/recovery work. Never create
		// a restart loop after a failed handoff.
		return
	}
}
