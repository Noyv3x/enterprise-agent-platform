//go:build linux

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/config"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffstartup"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

const handoffTransactionEnvironment = "AGENT_PLATFORM_HANDOFF_TRANSACTION_DIRECTORY"

type invocationStartup struct {
	decision       handoffstartup.Decision
	abort          *handoffstartup.AbortSourceDecision
	mode           invocationStartupMode
	txDir          string
	stateHome      string
	configuration  config.Config
	configSnapshot startupConfigSnapshot
	configBound    bool
	authority      *startupHandoffAuthority
}

type startupHandoffAuthority struct {
	store    *handoff.Store
	lease    *handoffstartup.AuthorityLease
	baseline func(context.Context) error
	mu       sync.Mutex
	closed   bool
}

func (authority *startupHandoffAuthority) Revalidate(ctx context.Context) error {
	if authority == nil {
		return errors.New("startup handoff authority is unavailable")
	}
	authority.mu.Lock()
	defer authority.mu.Unlock()
	if authority.closed {
		return errors.New("startup handoff authority is closed")
	}
	if authority.baseline != nil {
		return authority.baseline(ctx)
	}
	if authority.store == nil || authority.lease == nil {
		return errors.New("startup handoff authority is unavailable")
	}
	return authority.lease.Revalidate(ctx)
}

func (authority *startupHandoffAuthority) Transfer(ctx context.Context) error {
	if authority == nil {
		return errors.New("startup handoff authority is unavailable")
	}
	authority.mu.Lock()
	defer authority.mu.Unlock()
	if authority.closed {
		return errors.New("startup handoff authority is closed")
	}
	if authority.baseline != nil {
		if err := authority.baseline(ctx); err != nil {
			return err
		}
		return authority.closeLocked()
	}
	if authority.store == nil || authority.lease == nil {
		return errors.New("startup handoff authority is unavailable")
	}
	if err := authority.lease.Revalidate(ctx); err != nil {
		return err
	}
	return authority.closeLocked()
}

func (authority *startupHandoffAuthority) Close() error {
	if authority == nil {
		return nil
	}
	authority.mu.Lock()
	defer authority.mu.Unlock()
	return authority.closeLocked()
}

func (authority *startupHandoffAuthority) closeLocked() error {
	if authority.closed {
		return nil
	}
	authority.closed = true
	if authority.baseline != nil {
		return nil
	}
	if authority.lease == nil || authority.store == nil {
		return errors.New("startup handoff authority is unavailable")
	}
	return errors.Join(authority.lease.Close(), authority.store.Close())
}

func (startup invocationStartup) closeAuthority() error {
	if startup.authority == nil {
		return nil
	}
	return startup.authority.Close()
}

func (startup invocationStartup) transferAuthority(ctx context.Context) error {
	if startup.authority == nil {
		return errors.New("routed startup did not retain handoff authority")
	}
	return startup.authority.Transfer(ctx)
}

type invocationStartupMode uint8

const (
	invocationStartupStable invocationStartupMode = iota
	invocationStartupFormalParticipant
	invocationStartupAbortParticipant
)

func (startup invocationStartup) participant() bool {
	return startup.mode == invocationStartupFormalParticipant || startup.mode == invocationStartupAbortParticipant
}

func (startup invocationStartup) activeProfile() identity.ActiveProfile {
	if startup.mode == invocationStartupAbortParticipant {
		return identity.SourceActiveProfile()
	}
	return startup.decision.ActiveProfile
}

func selectedInvocationConfig(startup invocationStartup) (string, error) {
	path := startup.decision.Paths.ConfigPath
	if startup.mode == invocationStartupAbortParticipant && startup.abort != nil {
		path = startup.abort.Paths.ConfigPath
	}
	if startup.mode == invocationStartupFormalParticipant &&
		(startup.decision.Snapshot == nil || startup.decision.Snapshot.ConfigPath != path ||
			startup.decision.Snapshot.ConfigSHA256 != startup.decision.ConfigSHA256) {
		return "", errors.New("startup capability config differs from the resolved technical identity")
	}
	if startup.mode == invocationStartupAbortParticipant &&
		(startup.abort == nil || startup.abort.Paths.ConfigPath != path || startup.abort.Snapshot.ConfigPath != path ||
			startup.abort.Snapshot.ConfigSHA256 != startup.abort.ConfigSHA256) {
		return "", errors.New("abort startup capability config differs from the resolved source identity")
	}
	if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return "", errors.New("routed Manager config path is invalid")
	}
	return path, nil
}

// bindInvocationConfig treats argv only as a value to compare with the
// already-routed identity. It never uses --config to select a profile.
func bindInvocationConfig(arguments []string, startup invocationStartup) ([]string, error) {
	return bindInvocationConfigMode(arguments, startup, false)
}

func bindRequiredInvocationConfig(arguments []string, startup invocationStartup) ([]string, error) {
	return bindInvocationConfigMode(arguments, startup, true)
}

func retainedInvocationConfig(ctx context.Context, startup invocationStartup, requireStableProcess bool) (config.Config, error) {
	expected, err := selectedInvocationConfig(startup)
	if err != nil {
		return config.Config{}, err
	}
	if !startup.configBound || startup.configuration.ConfigPath != expected {
		return config.Config{}, errors.New("startup router did not retain its authenticated Manager configuration")
	}
	if err := startup.configuration.ValidateFor(startup.activeProfile()); err != nil {
		return config.Config{}, err
	}
	if err := verifyStartupConfigSnapshotStillBound(startup.configSnapshot); err != nil {
		return config.Config{}, err
	}
	if startup.authority != nil {
		if requireStableProcess {
			return config.Config{}, errors.New("stable Manager command unexpectedly retained non-stable startup authority")
		}
		if err := startup.authority.Revalidate(ctx); err != nil {
			return config.Config{}, err
		}
	} else if err := verifyRoutedStartupDecision(ctx, startup, requireStableProcess); err != nil {
		return config.Config{}, err
	}
	return startup.configuration, nil
}

func bindInvocationConfigMode(arguments []string, startup invocationStartup, requireExplicit bool) ([]string, error) {
	expected, err := selectedInvocationConfig(startup)
	if err != nil {
		return nil, err
	}
	result := append([]string(nil), arguments...)
	found := false
	for index := 0; index < len(result); index++ {
		argument := result[index]
		var supplied string
		switch {
		case argument == "--config" || argument == "-config":
			if index+1 >= len(result) {
				return nil, errors.New("Manager config argument is missing its value")
			}
			supplied = result[index+1]
			index++
		case strings.HasPrefix(argument, "--config="):
			supplied = strings.TrimPrefix(argument, "--config=")
		case strings.HasPrefix(argument, "-config="):
			supplied = strings.TrimPrefix(argument, "-config=")
		default:
			continue
		}
		if found {
			return nil, errors.New("Manager config argument was supplied more than once")
		}
		found = true
		if supplied == "" || !filepath.IsAbs(supplied) || filepath.Clean(supplied) != supplied || supplied != expected {
			return nil, errors.New("Manager config argument differs from the routed technical identity")
		}
	}
	if !found && requireExplicit {
		return nil, errors.New("this command requires an explicit --config path matching the routed technical identity")
	}
	if !found {
		result = append(result, "--config", expected)
	}
	return result, nil
}

// resolveInvocationStartup runs before any profile-specific config or Manager
// state is opened. transactionDirectory identifies only a helper-owned
// capability channel; it is never interpreted as a profile selector.
func resolveInvocationStartup(ctx context.Context, transactionDirectory string) (invocationStartup, error) {
	return resolveInvocationStartupMode(ctx, transactionDirectory, true, "")
}

func resolveInvocationStartupWithConfig(ctx context.Context, transactionDirectory, configPath string) (invocationStartup, error) {
	return resolveInvocationStartupMode(ctx, transactionDirectory, true, configPath)
}

// resolveInvocationAuthority is reserved for self-update watchdog and
// external recovery commands. Those processes intentionally execute an
// immutable non-stable inode and must complete their own plan/journal proof
// after this neutral technical-profile selection.
func resolveInvocationAuthority(ctx context.Context) (invocationStartup, error) {
	return resolveInvocationStartupMode(ctx, "", false, "")
}

func resolveInvocationAuthorityWithConfig(ctx context.Context, configPath string) (invocationStartup, error) {
	return resolveInvocationStartupMode(ctx, "", false, configPath)
}

func resolveInvocationStartupMode(ctx context.Context, transactionDirectory string, requireStableProcess bool, configPath string) (invocationStartup, error) {
	result := invocationStartup{mode: invocationStartupStable}
	if transactionDirectory != "" {
		router := handoffstartup.NewCapabilityRouter()
		located, routeErr := router.RouteFromHelperLocator(ctx, transactionDirectory)
		if routeErr != nil {
			return invocationStartup{}, fmt.Errorf("route helper-started Manager: %w", routeErr)
		}
		result.txDir = transactionDirectory
		result.stateHome, routeErr = startupStateHomeFromTransaction(transactionDirectory)
		if routeErr != nil {
			return invocationStartup{}, routeErr
		}
		switch located.Mode {
		case handoffstartup.HelperLocatorFormal:
			if located.Formal == nil || located.AbortSource != nil {
				return invocationStartup{}, errors.New("formal helper startup locator returned an invalid decision")
			}
			result.decision = *located.Formal
			result.mode = invocationStartupFormalParticipant
		case handoffstartup.HelperLocatorAbortSource:
			if located.AbortSource == nil || located.Formal != nil {
				return invocationStartup{}, errors.New("abort helper startup locator returned an invalid decision")
			}
			result.abort = located.AbortSource
			result.mode = invocationStartupAbortParticipant
		default:
			return invocationStartup{}, errors.New("helper startup locator returned an unknown decision")
		}
		if err := bindStartupConfigPath(configPath, &result); err != nil {
			return invocationStartup{}, err
		}
		return result, nil
	}

	locator, err := locateStartupConfigSnapshot(configPath)
	if err != nil {
		return invocationStartup{}, err
	}
	stateHome := locator.StateHome
	handoffRoot := filepath.Join(stateHome, "agent-platform", "handoff")
	result.stateHome = stateHome
	store, err := handoff.OpenExisting(handoffRoot)
	if err != nil {
		// OpenExisting adds operation context around the underlying filesystem
		// error. errors.Is preserves that cause; os.IsNotExist does not reliably
		// recognise every wrapped form. A never-migrated source deployment must
		// therefore take the explicit baseline route instead of failing before
		// build can create the neutral handoff root.
		if errors.Is(err, handoff.ErrNoJournals) || errors.Is(err, os.ErrNotExist) {
			baselineActive, profileErr := identity.CompileTimeActiveProfile()
			if profileErr != nil {
				return invocationStartup{}, fmt.Errorf("select compiled baseline technical profile: %w", profileErr)
			}
			bootstrap, snapshot, loadErr := loadBaselineBootstrapConfig(baselineActive, configPath, locator)
			if loadErr != nil {
				return invocationStartup{}, loadErr
			}
			if bootstrap.StateHome != stateHome {
				return invocationStartup{}, errors.New("full baseline config state_home differs from the startup routing snapshot")
			}
			if err := verifyStartupConfigSnapshotStillBound(snapshot); err != nil {
				return invocationStartup{}, err
			}
			if err := confirmNoTerminalHandoff(handoffRoot); err != nil {
				return invocationStartup{}, err
			}
			result.configuration = bootstrap
			result.configSnapshot = snapshot
			result.configBound = true
			result.stateHome = stateHome
			paths, pathErr := baselineRuntimePaths(baselineActive, bootstrap)
			if pathErr != nil {
				return invocationStartup{}, pathErr
			}
			if requireStableProcess {
				result.decision, err = handoffstartup.RouteCompileTimeBaselinePaths(paths)
			} else if baselineActive == identity.SourceActiveProfile() {
				// Bridge still has a writer capable of creating the one-time
				// handoff journal. Retain its empty observation until the
				// watchdog/recovery plan has acquired its own authority.
				store, err = handoff.Open(handoffRoot, bootstrap.DataRoot, bootstrap.TargetDataRoot())
				if err != nil {
					return invocationStartup{}, fmt.Errorf("open baseline startup authority Store: %w", err)
				}
				router, routerErr := handoffstartup.NewTerminalRouter(store)
				if routerErr != nil {
					_ = store.Close()
					return invocationStartup{}, routerErr
				}
				var authorityLease *handoffstartup.AuthorityLease
				result.decision, authorityLease, err = router.RouteBaselineSourceAuthorityRetained(ctx, paths)
				if err != nil {
					_ = store.Close()
				} else {
					result.authority = &startupHandoffAuthority{store: store, lease: authorityLease}
					if result.decision.ActiveProfile != baselineActive ||
						!reflect.DeepEqual(result.decision.Paths, paths) || result.decision.TransactionID != "" {
						_ = result.closeAuthority()
						return invocationStartup{}, errors.New("a handoff journal appeared while baseline recovery authority was being routed")
					}
				}
			} else {
				// Cleanup/target-baseline contains no handoff writer. Its
				// watchdog and recovery still revalidate the exact compiled
				// target layout and absence of a journal, but must not create a
				// source-shaped Store merely to hold a compatibility lease.
				result.decision, err = handoffstartup.RouteCompileTimeBaselineAuthorityPaths(paths)
				if err == nil {
					expected := result.decision
					result.authority = &startupHandoffAuthority{baseline: func(revalidate context.Context) error {
						if err := revalidate.Err(); err != nil {
							return err
						}
						if err := confirmNoTerminalHandoff(handoffRoot); err != nil {
							return err
						}
						current, err := handoffstartup.RouteCompileTimeBaselineAuthorityPaths(paths)
						if err != nil {
							return err
						}
						if !reflect.DeepEqual(current, expected) {
							return errors.New("compiled target baseline identity changed during authority transfer")
						}
						return nil
					}}
				}
			}
			if err != nil {
				return invocationStartup{}, err
			}
			return result, nil
		}
		return invocationStartup{}, fmt.Errorf("open terminal handoff routing state: %w", err)
	}
	router, err := handoffstartup.NewTerminalRouter(store)
	if err != nil {
		_ = store.Close()
		return invocationStartup{}, err
	}
	if requireStableProcess {
		defer store.Close()
		result.decision, err = router.RouteTerminal(ctx)
	} else {
		var authorityLease *handoffstartup.AuthorityLease
		result.decision, authorityLease, err = router.RouteTerminalAuthorityRetained(ctx)
		if err == nil {
			result.authority = &startupHandoffAuthority{store: store, lease: authorityLease}
		}
	}
	if err != nil {
		if !requireStableProcess {
			_ = store.Close()
		}
		return invocationStartup{}, fmt.Errorf("route terminal Manager identity: %w", err)
	}
	if err := bindStartupConfigPath(configPath, &result); err != nil {
		_ = result.closeAuthority()
		return invocationStartup{}, err
	}
	return result, nil
}

func loadBaselineBootstrapConfig(active identity.ActiveProfile, path string, located startupConfigSnapshot) (config.Config, startupConfigSnapshot, error) {
	if err := active.Validate(); err != nil {
		return config.Config{}, startupConfigSnapshot{}, err
	}
	if path == "" {
		path = located.Path
	}
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return config.Config{}, startupConfigSnapshot{}, errors.New("startup config path must be canonical and absolute")
	}
	if located.Path != path {
		return config.Config{}, startupConfigSnapshot{}, errors.New("baseline config path differs from the startup routing snapshot")
	}
	value, err := config.LoadStartupSnapshot(active, path, located.Raw, located.Exists, located.StateHome)
	if err != nil {
		return config.Config{}, startupConfigSnapshot{}, fmt.Errorf("load baseline startup config snapshot: %w", err)
	}
	return value, located, nil
}

func confirmNoTerminalHandoff(root string) error {
	store, err := handoff.OpenExisting(root)
	if err == nil {
		closeErr := store.Close()
		return errors.Join(closeErr, errors.New("a handoff journal appeared while source startup was being routed"))
	}
	if errors.Is(err, handoff.ErrNoJournals) || errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return fmt.Errorf("reconfirm absent terminal handoff routing state: %w", err)
}

// verifyRoutedStartupDecision closes the gap between neutral identity routing
// and a profile-specific action. The current process retains the parsed
// snapshot, then proves both its path binding and the handoff decision again;
// serve invokes it while holding the singleton, and routed CLI commands invoke
// it immediately before dispatch.
func verifyRoutedStartupDecision(ctx context.Context, startup invocationStartup, requireStableProcess bool) error {
	if !startup.configBound || startup.configuration.ConfigPath == "" {
		return errors.New("routed startup has no authenticated configuration snapshot")
	}
	if err := verifyStartupConfigSnapshotStillBound(startup.configSnapshot); err != nil {
		return err
	}
	if !startup.participant() && startup.decision.TransactionID == "" {
		if err := confirmNoTerminalHandoff(filepath.Join(startup.stateHome, "agent-platform", "handoff")); err != nil {
			return err
		}
		paths := startup.configurationRuntimePaths()
		var current handoffstartup.Decision
		var err error
		if requireStableProcess {
			current, err = handoffstartup.RouteCompileTimeBaselinePaths(paths)
		} else {
			return errors.New("non-stable baseline revalidation requires a retained handoff authority lease")
		}
		if err != nil {
			return fmt.Errorf("reprove compiled baseline identity: %w", err)
		}
		if current.ActiveProfile != startup.activeProfile() || current.TransactionID != "" ||
			!reflect.DeepEqual(current.Paths, startup.decision.Paths) {
			return errors.New("compiled baseline identity changed after startup routing")
		}
		return nil
	}
	current, err := resolveInvocationStartupMode(ctx, "", requireStableProcess, startup.configuration.ConfigPath)
	if err != nil {
		return fmt.Errorf("reroute terminal handoff identity: %w", err)
	}
	if current.participant() || !current.configBound || current.activeProfile() != startup.activeProfile() ||
		!reflect.DeepEqual(current.decision.Paths, startup.configurationRuntimePaths()) ||
		!reflect.DeepEqual(current.configuration, startup.configuration) {
		return errors.New("terminal handoff identity changed after startup routing")
	}
	expectedTransaction := startup.decision.TransactionID
	expectedBinding := startup.decision.BindingSHA256
	if startup.mode == invocationStartupAbortParticipant && startup.abort != nil {
		expectedTransaction = startup.abort.TransactionID
		expectedBinding = startup.abort.BindingSHA256
	}
	if current.decision.TransactionID != expectedTransaction || current.decision.BindingSHA256 != expectedBinding {
		return errors.New("terminal handoff transaction changed after startup routing")
	}
	if !startup.participant() && current.decision.Revision != startup.decision.Revision {
		return errors.New("terminal handoff revision changed after startup routing")
	}
	return nil
}

func (startup invocationStartup) configurationRuntimePaths() handoffstartup.RuntimePaths {
	return handoffstartup.RuntimePaths{
		StableBinary: startup.selectedStableBinary(),
		ConfigPath:   startup.configuration.ConfigPath,
		DataRoot:     startup.configuration.DataRoot,
		StateRoot:    startup.configuration.StateDir,
		SocketPath:   startup.configuration.SocketPath,
	}
}

func (startup invocationStartup) selectedStableBinary() string {
	paths := startup.decision.Paths
	if startup.mode == invocationStartupAbortParticipant && startup.abort != nil {
		paths = startup.abort.Paths
	}
	return paths.StableBinary
}

func baselineRuntimePaths(active identity.ActiveProfile, baseline config.Config) (handoffstartup.RuntimePaths, error) {
	stable := managerInstallPath(active)
	if stable == "" {
		return handoffstartup.RuntimePaths{}, errors.New("resolve baseline stable Manager path")
	}
	return handoffstartup.RuntimePaths{
		StableBinary: stable,
		ConfigPath:   baseline.ConfigPath,
		DataRoot:     baseline.DataRoot,
		StateRoot:    baseline.StateDir,
		SocketPath:   baseline.SocketPath,
	}, nil
}

func bindStartupConfigPath(supplied string, startup *invocationStartup) error {
	if startup == nil {
		return errors.New("startup config binding is missing")
	}
	expected, err := selectedInvocationConfig(*startup)
	if err != nil {
		return err
	}
	if supplied != "" && supplied != expected {
		return errors.New("Manager config argument differs from the routed technical identity")
	}
	snapshot, err := locateStartupConfigSnapshot(expected)
	if err != nil {
		return fmt.Errorf("capture routed Manager config: %w", err)
	}
	if !snapshot.Exists {
		return errors.New("routed Manager config is not an existing regular file")
	}
	expectedDigest := startup.decision.ConfigSHA256
	if startup.mode == invocationStartupAbortParticipant && startup.abort != nil {
		expectedDigest = startup.abort.ConfigSHA256
	}
	retainedDigest, err := startupConfigSnapshotSHA256(snapshot)
	if err != nil {
		return fmt.Errorf("digest routed Manager config: %w", err)
	}
	if expectedDigest != "" && retainedDigest != expectedDigest {
		return errors.New("routed Manager config digest differs from the handoff binding")
	}
	active := startup.activeProfile()
	value, err := config.LoadStartupSnapshot(active, expected, snapshot.Raw, snapshot.Exists, snapshot.StateHome)
	if err != nil {
		return fmt.Errorf("load routed Manager config: %w", err)
	}
	paths := startup.decision.Paths
	if startup.mode == invocationStartupAbortParticipant && startup.abort != nil {
		paths = startup.abort.Paths
	}
	if value.ConfigPath != paths.ConfigPath || value.DataRoot != paths.DataRoot || value.StateDir != paths.StateRoot || value.StateHome != startup.stateHome || value.SocketPath != paths.SocketPath {
		return errors.New("routed Manager config differs from the journal runtime binding")
	}
	if err := verifyStartupConfigSnapshotStillBound(snapshot); err != nil {
		return err
	}
	startup.configuration = value
	startup.configSnapshot = snapshot
	startup.configBound = true
	return nil
}

func startupStateHomeFromTransaction(transactionDirectory string) (string, error) {
	handoffRoot := filepath.Dir(transactionDirectory)
	if filepath.Base(handoffRoot) != "handoff" || filepath.Base(filepath.Dir(handoffRoot)) != "agent-platform" {
		return "", errors.New("startup transaction is outside the neutral handoff root")
	}
	stateHome := filepath.Dir(filepath.Dir(handoffRoot))
	if !canonicalStartupPath(stateHome) {
		return "", errors.New("startup transaction has an invalid state home")
	}
	return stateHome, nil
}
