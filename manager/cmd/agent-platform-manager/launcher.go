package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/config"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/selfupdate"
)

func supervisorManager(cfg config.Config) *selfupdate.Manager {
	return &selfupdate.Manager{
		Profile: identity.CompileTimeActiveProfile(), ConfigPath: cfg.ConfigPath,
		Root: filepath.Join(cfg.StateDir, "manager-binaries"), StatePath: filepath.Join(cfg.StateDir, "manager-binaries.json"),
		InstallPath: managerInstallPath(), SocketPath: cfg.SocketPath, ControlTokenFile: cfg.ControlTokenFile(),
		UnitName: identity.TargetProfile().ManagerUnit, RunningVersion: version,
	}
}

func launcherCommand(command string, arguments []string) error {
	set, path := commonFlags(command)
	if err := set.Parse(arguments); err != nil {
		return err
	}
	cfg, err := load(*path)
	if err != nil {
		return err
	}
	manager := supervisorManager(cfg)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if command == "bootstrap-launcher" {
		launcher, err := manager.BootstrapLauncher(ctx)
		if err != nil {
			return err
		}
		fmt.Println(launcher.Path)
		return nil
	}
	err = manager.RunLauncher(ctx, nil)
	if errors.Is(err, selfupdate.ErrLauncherStopped) {
		fmt.Fprintf(os.Stderr, "Manager launcher stopped: %v\n", err)
		return nil
	}
	return err
}
