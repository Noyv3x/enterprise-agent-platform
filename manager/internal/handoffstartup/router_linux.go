//go:build linux

package handoffstartup

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

func currentPID() int { return os.Getpid() }

func newRouter(store *handoff.Store, bindings Bindings, clock Clock, pid func() int) (*Router, error) {
	if store == nil {
		return nil, errors.New("startup router requires an open handoff Store")
	}
	if clock == nil || pid == nil {
		return nil, errors.New("startup router requires a clock and process identity")
	}
	if err := validateBindings(bindings); err != nil {
		return nil, err
	}
	return &Router{store: store, bindings: bindings, clock: clock, pid: pid}, nil
}

func newHelperRouter(bindings Bindings, clock Clock, pid func() int) (*Router, error) {
	if clock == nil || pid == nil {
		return nil, errors.New("startup router requires a clock and process identity")
	}
	if err := validateBindings(bindings); err != nil {
		return nil, err
	}
	return &Router{bindings: bindings, clock: clock, pid: pid}, nil
}

func validateBindings(bindings Bindings) error {
	if err := validateRuntimePaths("source", identity.SourceProfile(), bindings.Source); err != nil {
		return err
	}
	if err := validateRuntimePaths("target", identity.TargetProfile(), bindings.Target); err != nil {
		return err
	}
	left := []string{bindings.Source.StableBinary, bindings.Source.ConfigPath, bindings.Source.DataRoot, bindings.Source.StateRoot, bindings.Source.SocketPath}
	right := []string{bindings.Target.StableBinary, bindings.Target.ConfigPath, bindings.Target.DataRoot, bindings.Target.StateRoot, bindings.Target.SocketPath}
	for _, source := range left {
		for _, target := range right {
			if source == target || pathContains(source, target) || pathContains(target, source) {
				return errors.New("source and target startup identities overlap")
			}
		}
	}
	return nil
}

func validateRuntimePaths(label string, profile identity.Profile, paths RuntimePaths) error {
	for name, path := range map[string]string{
		"stable binary":  paths.StableBinary,
		"config":         paths.ConfigPath,
		"data root":      paths.DataRoot,
		"state root":     paths.StateRoot,
		"control socket": paths.SocketPath,
	} {
		if !canonicalAbsolute(path) {
			return fmt.Errorf("%s %s must be a canonical absolute path", label, name)
		}
	}
	if filepath.Base(paths.StableBinary) != profile.ManagerBinary {
		return fmt.Errorf("%s stable binary does not match the immutable profile", label)
	}
	// P1's installer has always allowed an arbitrary absolute source config
	// destination.  Target config identity, in contrast, is created only by the
	// handoff helper and remains canonical to the target profile.
	if profile != identity.SourceProfile() &&
		(filepath.Base(paths.ConfigPath) != profile.ConfigFile || filepath.Base(filepath.Dir(paths.ConfigPath)) != profile.ConfigDirectory) {
		return fmt.Errorf("%s config path does not match the immutable profile", label)
	}
	if paths.StateRoot != profile.ManagerStateRoot(paths.DataRoot) {
		return fmt.Errorf("%s Manager state root does not match the immutable profile", label)
	}
	if profile.DataRootSocketPath != "" {
		wanted, err := profile.ControlSocketPath(paths.DataRoot, "")
		if err != nil || paths.SocketPath != wanted {
			return fmt.Errorf("%s control socket does not match the immutable profile", label)
		}
	} else {
		suffix := string(filepath.Separator) + filepath.FromSlash(profile.RuntimeSocketPath)
		if !strings.HasSuffix(paths.SocketPath, suffix) {
			return fmt.Errorf("%s runtime control socket does not match the immutable profile", label)
		}
	}
	return nil
}

func (r *Router) routeTerminal(ctx context.Context, requireStableProcess bool) (Decision, error) {
	if r == nil || r.store == nil {
		return Decision{}, errors.New("startup router is unavailable")
	}
	if err := ctx.Err(); err != nil {
		return Decision{}, err
	}
	lease, before, err := r.store.OpenObservation()
	if err != nil {
		return Decision{}, fmt.Errorf("acquire startup journal observation: %w", err)
	}
	defer lease.Close()

	decision, err := r.routeTerminalSnapshot(ctx, before, requireStableProcess)
	if err != nil {
		return Decision{}, err
	}
	if err := ctx.Err(); err != nil {
		return Decision{}, err
	}
	after, err := lease.Read()
	if err != nil {
		return Decision{}, fmt.Errorf("re-read startup journal observation: %w", err)
	}
	if !reflect.DeepEqual(before, after) {
		return Decision{}, errors.New("handoff journals changed during startup routing")
	}
	return decision, nil
}

func (r *Router) routeTerminalSnapshot(ctx context.Context, journals []handoff.Journal, requireStableProcess bool) (Decision, error) {
	selected, target, err := selectTerminalJournal(journals)
	if err != nil {
		return Decision{}, err
	}
	bindings := r.bindings
	if bindings.Source.StableBinary == "" && bindings.Target.StableBinary == "" {
		bindings, err = bindingsFromJournals(journals)
		if err != nil {
			return Decision{}, err
		}
	}
	for _, journal := range journals {
		if err := validateJournalBindings(journal, bindings); err != nil {
			return Decision{}, err
		}
	}
	paths := bindings.Source
	profile := identity.SourceProfile()
	active := identity.SourceActiveProfile()
	if target {
		paths = bindings.Target
		profile = identity.TargetProfile()
		active, err = identity.ActivateVerifiedHandoffTarget(profile)
		if err != nil {
			return Decision{}, err
		}
	}
	if requireStableProcess {
		if err := verifyProcessExecutable(r.pid(), paths.StableBinary, expectedManagerSHA(selected, target)); err != nil {
			return Decision{}, fmt.Errorf("verify routed Manager executable: %w", err)
		}
	}
	if err := verifyRuntimeLayout(paths); err != nil {
		return Decision{}, fmt.Errorf("verify routed Manager layout: %w", err)
	}
	decision := Decision{ActiveProfile: active, Profile: profile, Paths: paths}
	if selected != nil {
		decision.TransactionID = selected.TransactionID
		decision.Revision = selected.Revision
		decision.BindingSHA256 = selected.BindingSHA256
		decision.ConfigSHA256 = selected.Source.ConfigSHA256
		if target {
			decision.ConfigSHA256 = selected.Target.ConfigSHA256
		}
	}
	return decision, nil
}

// AuthorityLease retains the exact Store observation that selected a
// watchdog/recovery technical identity. It deliberately does not own or close
// the Store; callers must close the lease before the Store.
type AuthorityLease struct {
	router      *Router
	observation *handoff.Observation
	before      []handoff.Journal
	decision    Decision
	baseline    bool
	mu          sync.Mutex
	closed      bool
}

func (r *Router) routeAuthorityRetained(ctx context.Context, baseline *RuntimePaths) (Decision, *AuthorityLease, error) {
	if r == nil || r.store == nil {
		return Decision{}, nil, errors.New("startup router is unavailable")
	}
	if err := ctx.Err(); err != nil {
		return Decision{}, nil, err
	}
	observation, before, err := r.store.OpenObservation()
	if err != nil {
		return Decision{}, nil, fmt.Errorf("acquire startup authority observation: %w", err)
	}
	closeOnError := true
	defer func() {
		if closeOnError {
			_ = observation.Close()
		}
	}()

	var decision Decision
	baselineSelected := len(before) == 0
	if baselineSelected {
		if baseline == nil {
			return Decision{}, nil, handoff.ErrNoJournals
		}
		decision, err = routeBaselineSourcePaths(*baseline, false)
	} else {
		decision, err = r.routeTerminalSnapshot(ctx, before, false)
	}
	if err != nil {
		return Decision{}, nil, err
	}
	after, err := observation.Read()
	if err != nil {
		return Decision{}, nil, fmt.Errorf("re-read startup authority observation: %w", err)
	}
	if !reflect.DeepEqual(before, after) {
		return Decision{}, nil, errors.New("handoff journals changed during startup authority routing")
	}
	lease := &AuthorityLease{
		router: r, observation: observation, before: cloneAuthorityJournals(before),
		decision: decision, baseline: baselineSelected,
	}
	closeOnError = false
	return decision, lease, nil
}

// Revalidate proves the same decision from the same retained root descriptor
// and global lease. It never reacquires the global lock by pathname.
func (lease *AuthorityLease) Revalidate(ctx context.Context) error {
	if lease == nil {
		return errors.New("startup authority lease is unavailable")
	}
	lease.mu.Lock()
	defer lease.mu.Unlock()
	if lease.closed || lease.observation == nil || lease.router == nil {
		return errors.New("startup authority lease is closed")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	current, err := lease.observation.Read()
	if err != nil {
		return fmt.Errorf("re-read retained startup authority: %w", err)
	}
	if !reflect.DeepEqual(lease.before, current) {
		return errors.New("handoff journals changed after startup authority routing")
	}
	var decision Decision
	if lease.baseline {
		if len(current) != 0 {
			return errors.New("baseline startup authority gained a handoff journal")
		}
		decision, err = routeBaselineSourcePaths(lease.decision.Paths, false)
	} else {
		decision, err = lease.router.routeTerminalSnapshot(ctx, current, false)
	}
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(decision, lease.decision) {
		return errors.New("startup authority decision changed while its lease was retained")
	}
	return nil
}

func (lease *AuthorityLease) Close() error {
	if lease == nil {
		return nil
	}
	lease.mu.Lock()
	defer lease.mu.Unlock()
	if lease.closed {
		return nil
	}
	lease.closed = true
	return lease.observation.Close()
}

func cloneAuthorityJournals(values []handoff.Journal) []handoff.Journal {
	// Journal is a closed JSON value containing maps/slices. A round trip would
	// hide schema mistakes; Store observations are already detached clones, so
	// copying the slice is sufficient as no reference is exposed to callers.
	// Preserve the Store's non-nil empty slice: reflect equality is part of the
	// retained double-read proof, so normalizing it to nil would make every
	// never-migrated baseline authority fail its final revalidation.
	result := make([]handoff.Journal, len(values))
	copy(result, values)
	return result
}

func bindingsFromJournals(journals []handoff.Journal) (Bindings, error) {
	if len(journals) == 0 {
		return Bindings{}, handoff.ErrNoJournals
	}
	first := journals[0]
	bindings := Bindings{
		Source: RuntimePaths{
			StableBinary: first.Source.StableBinary,
			ConfigPath:   first.Source.ConfigPath,
			DataRoot:     first.Source.DataRoot,
			StateRoot:    identity.SourceProfile().ManagerStateRoot(first.Source.DataRoot),
			SocketPath:   first.Source.SocketPath,
		},
		Target: RuntimePaths{
			StableBinary: first.Target.StableBinary,
			ConfigPath:   first.Target.ConfigPath,
			DataRoot:     first.Target.DataRoot,
			StateRoot:    identity.TargetProfile().ManagerStateRoot(first.Target.DataRoot),
			SocketPath:   first.Target.SocketPath,
		},
	}
	if err := validateBindings(bindings); err != nil {
		return Bindings{}, fmt.Errorf("derive terminal startup bindings: %w", err)
	}
	return bindings, nil
}

func selectTerminalJournal(journals []handoff.Journal) (*handoff.Journal, bool, error) {
	var committed *handoff.Journal
	var latest *handoff.Journal
	for index := range journals {
		journal := journals[index]
		if !journal.Terminal() {
			return nil, false, ErrCapabilityRequired
		}
		if latest == nil || journal.CreatedAt.After(latest.CreatedAt) {
			copy := journal
			latest = &copy
		}
		if journal.Status != handoff.StatusCommitted {
			continue
		}
		if committed != nil {
			return nil, false, fmt.Errorf("%w: multiple committed handoffs", ErrProfileConflict)
		}
		copy := journal
		committed = &copy
	}
	if committed == nil {
		return latest, false, nil
	}
	for _, journal := range journals {
		if journal.TransactionID != committed.TransactionID && journal.CreatedAt.After(committed.CreatedAt) {
			return nil, false, fmt.Errorf("%w: a later terminal transaction follows the committed handoff", ErrProfileConflict)
		}
	}
	return committed, true, nil
}

func expectedManagerSHA(journal *handoff.Journal, target bool) string {
	if journal == nil {
		// A never-migrated source deployment has no journal digest to compare.
		// verifyProcessExecutable still proves the running/stable inode identity.
		return ""
	}
	if target {
		return journal.Release.TargetManagerSHA256
	}
	return journal.Source.StableSHA256
}

func validateJournalBindings(journal handoff.Journal, bindings Bindings) error {
	if err := handoff.Validate(journal); err != nil {
		return fmt.Errorf("validate startup handoff journal: %w", err)
	}
	sourceProfile := identity.SourceProfile()
	targetProfile := identity.TargetProfile()
	if journal.Source.Namespace != sourceProfile.ProfileID || journal.Source.Unit != sourceProfile.ManagerUnit ||
		journal.Source.StableBinary != bindings.Source.StableBinary || journal.Source.ConfigPath != bindings.Source.ConfigPath ||
		journal.Source.DataRoot != bindings.Source.DataRoot || journal.Source.SocketPath != bindings.Source.SocketPath ||
		journal.Source.ComposeProject != sourceProfile.ComposeProject || journal.Source.CoreNetwork != sourceProfile.CoreNetwork ||
		journal.Source.LabelPrefix != sourceProfile.LabelPrefix {
		return errors.New("handoff journal source startup binding differs from the immutable source layout")
	}
	if journal.Target.Namespace != targetProfile.ProfileID || journal.Target.Unit != targetProfile.ManagerUnit ||
		journal.Target.StableBinary != bindings.Target.StableBinary || journal.Target.ConfigPath != bindings.Target.ConfigPath ||
		journal.Target.DataRoot != bindings.Target.DataRoot || journal.Target.SocketPath != bindings.Target.SocketPath ||
		journal.Target.ComposeProject != targetProfile.ComposeProject || journal.Target.CoreNetwork != targetProfile.CoreNetwork ||
		journal.Target.LabelPrefix != targetProfile.LabelPrefix {
		return errors.New("handoff journal target startup binding differs from the immutable target layout")
	}
	return nil
}

func canonicalAbsolute(path string) bool {
	return path != "" && filepath.IsAbs(path) && filepath.Clean(path) == path && !strings.ContainsRune(path, 0)
}

func pathContains(parent, child string) bool {
	relative, err := filepath.Rel(parent, child)
	return err == nil && relative != "." && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
