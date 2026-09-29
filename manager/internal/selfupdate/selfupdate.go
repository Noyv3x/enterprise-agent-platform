package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

type Version struct {
	Version           string    `json:"version"`
	SourceCommit      string    `json:"source_commit"`
	Path              string    `json:"path"`
	SHA256            string    `json:"sha256"`
	VerifiedAt        time.Time `json:"verified_at"`
	PlatformCommitted bool      `json:"platform_committed"`
}

// State is the binary projection consumed by the installed N launcher.
// Activation is opaque: N+1 refuses legacy activation rather than decoding it.
type State struct {
	SchemaVersion int             `json:"schema_version"`
	Current       *Version        `json:"current,omitempty"`
	Previous      *Version        `json:"previous,omitempty"`
	Candidate     *Version        `json:"candidate,omitempty"`
	Activation    json.RawMessage `json:"activation,omitempty"`
	UpdatedAt     time.Time       `json:"updated_at"`
}

type Runner interface {
	Run(context.Context, string, ...string) error
}

type CommandRunner struct{}

func (CommandRunner) Run(ctx context.Context, name string, args ...string) error {
	output, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %w: %s", name, err, strings.TrimSpace(string(output)))
	}
	return nil
}

type Manager struct {
	Profile                     identity.ActiveProfile
	ConfigPath                  string
	Root                        string
	StatePath                   string
	InstallPath                 string
	SocketPath                  string
	ControlTokenFile            string
	UnitName                    string
	RunningVersion              string
	Client                      release.Client
	Runner                      Runner
	Now                         func() time.Time
	LauncherHealthTimeout       time.Duration
	launcherRegistrationPending func()
}

// RequireSupervisor refuses an unsettled bridge without interpreting its journals.
func (m *Manager) RequireSupervisor() error {
	if err := validateRecoveryDirectory(m.Root, true); err != nil {
		return fmt.Errorf("unsafe supervisor state root: %w", err)
	}
	s, err := m.readLauncher()
	if err != nil {
		return fmt.Errorf("N supervisor required; complete release N handoff first: %w", err)
	}
	if !s.Proven && !s.Bootstrap {
		return errors.New("N supervisor handoff is not terminal; complete release N handoff first")
	}
	handoff, _, handoffErr := readRecoveryRegularFile(filepath.Join(m.Root, "bridge-handoff.json"), 3<<20, true)
	if handoffErr == nil {
		var terminal struct {
			Status   string  `json:"status"`
			Launcher Version `json:"launcher"`
		}
		if err := decodeRecoveryJSON(handoff, &terminal); err != nil {
			return err
		}
		if terminal.Status != "proven" || terminal.Launcher.Path != s.Launcher.Path || terminal.Launcher.SHA256 != s.Launcher.SHA256 || terminal.Launcher.Version != s.Launcher.Version {
			return errors.New("release N supervisor handoff is not terminal and bound; complete it using release N")
		}
	} else if !os.IsNotExist(handoffErr) || !s.Bootstrap {
		return fmt.Errorf("release N terminal supervisor handoff is required: %w", handoffErr)
	}
	if err := m.verifyLauncherVersion(s.Launcher, true); err != nil {
		return err
	}
	if s.Previous == nil {
		return errors.New("supervisor has no verified previous Manager")
	}
	if err := m.verifyLauncherVersion(*s.Previous, false); err != nil {
		return err
	}
	if err := m.verifyLauncherVersion(s.Selected, false); err != nil {
		return err
	}
	state, err := m.load()
	if err != nil {
		return err
	}
	if len(state.Activation) != 0 && string(state.Activation) != "null" {
		return errors.New("legacy Manager activation remains; settle it using release N")
	}
	return nil
}

func (m *Manager) SupervisedTransition() (Version, error) {
	if err := m.RequireSupervisor(); err != nil {
		return Version{}, err
	}
	bound, err := m.SupervisedStartup()
	if err != nil {
		return Version{}, err
	}
	if !bound {
		return Version{}, errors.New("Manager is not an authenticated supervisor child")
	}
	s, err := m.readLauncher()
	if err != nil {
		return Version{}, err
	}
	if !s.Selected.PlatformCommitted {
		return Version{}, errors.New("selected Manager is not activation-ready")
	}
	return s.Selected, nil
}

func (m *Manager) Prepare(ctx context.Context, manifest release.Manifest) error {
	if err := m.RequireSupervisor(); err != nil {
		return err
	}
	if !validSourceCommit(manifest.SourceCommit) {
		return errors.New("invalid release commit")
	}
	unlock, err := m.acquireLauncherMutation()
	if err != nil {
		return err
	}
	defer unlock()
	launcher, err := m.readLauncher()
	if err != nil {
		return err
	}
	if !launcher.Proven || launcher.Failed || launcher.Pending || launcher.Rejected == manifest.SourceCommit {
		return errors.New("supervisor activation is not settled or candidate was rejected")
	}
	artifact, ok := manifest.Manager.Artifacts[runtime.GOARCH]
	if !ok || !validSHA256(artifact.SHA256) {
		return errors.New("invalid Manager artifact")
	}
	state, err := m.load()
	if err != nil {
		return err
	}
	if state.Current == nil {
		return errors.New("supervisor Current is missing")
	}
	if state.Current.SourceCommit == manifest.SourceCommit {
		if state.Current.Version != manifest.Manager.Version || state.Current.SHA256 != artifact.SHA256 {
			return errors.New("Current identity conflicts with manifest")
		}
		return m.verifyLauncherVersion(*state.Current, false)
	}
	if state.Candidate != nil {
		if state.Candidate.SourceCommit != manifest.SourceCommit || state.Candidate.SHA256 != artifact.SHA256 || state.Candidate.Version != manifest.Manager.Version {
			return errors.New("another Manager candidate is prepared")
		}
		return m.verifyLauncherVersion(*state.Candidate, false)
	}
	data, err := m.Client.FetchArtifact(ctx, artifact, 128<<20)
	if err != nil {
		return err
	}
	if sha256Hex(data) != artifact.SHA256 {
		return errors.New("Manager artifact checksum mismatch")
	}
	dir := filepath.Join(m.Root, "versions", safeID(manifest.Manager.Version+"-"+manifest.SourceCommit[:12]))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := validateRecoveryDirectory(dir, true); err != nil {
		return err
	}
	path := filepath.Join(dir, m.managerBinaryName())
	if err := atomicfile.WriteFile(path, data, 0o700); err != nil {
		return err
	}
	probe, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	output, err := exec.CommandContext(probe, path, "version").CombinedOutput()
	if err != nil || strings.TrimSpace(string(output)) != manifest.Manager.Version {
		return fmt.Errorf("staged Manager version verification failed: %q: %v", output, err)
	}
	candidate := Version{Version: manifest.Manager.Version, SourceCommit: manifest.SourceCommit, Path: path, SHA256: artifact.SHA256, VerifiedAt: m.now()}
	if err := m.ensureVersionMetadata(candidate); err != nil {
		return err
	}
	state.Candidate = &candidate
	state.UpdatedAt = m.now()
	return atomicfile.WriteJSON(m.StatePath, state, 0o600)
}

func (m *Manager) DiscardPrepared(manifest release.Manifest) error {
	unlock, err := m.acquireLauncherMutation()
	if err != nil {
		return err
	}
	defer unlock()
	s, err := m.readLauncher()
	if err != nil {
		return err
	}
	if s.Pending {
		return errors.New("cannot discard selected candidate")
	}
	state, err := m.load()
	if err != nil {
		return err
	}
	if state.Candidate == nil {
		return nil
	}
	artifact, ok := manifest.Manager.Artifacts[runtime.GOARCH]
	if !ok || state.Candidate.SourceCommit != manifest.SourceCommit || state.Candidate.SHA256 != artifact.SHA256 {
		return errors.New("prepared Manager identity mismatch")
	}
	state.Candidate = nil
	state.UpdatedAt = m.now()
	return atomicfile.WriteJSON(m.StatePath, state, 0o600)
}

// MarkPlatformCommitted retains N's wire name for the activation-ready marker;
// this does not acknowledge the Platform gate commit.
func (m *Manager) MarkPlatformCommitted(manifest release.Manifest) error {
	unlock, err := m.acquireLauncherMutation()
	if err != nil {
		return err
	}
	defer unlock()
	state, err := m.load()
	if err != nil {
		return err
	}
	if state.Current != nil && state.Current.SourceCommit == manifest.SourceCommit {
		return nil
	}
	if state.Candidate == nil || state.Candidate.SourceCommit != manifest.SourceCommit {
		return errors.New("verified manager candidate does not match committed release")
	}
	artifact, ok := manifest.Manager.Artifacts[runtime.GOARCH]
	if !ok || state.Candidate.Version != manifest.Manager.Version || state.Candidate.SHA256 != artifact.SHA256 {
		return errors.New("candidate artifact does not match activation-ready manifest")
	}
	state.Candidate.PlatformCommitted = true
	state.UpdatedAt = m.now()
	return atomicfile.WriteJSON(m.StatePath, state, 0o600)
}

func (m *Manager) Activate(ctx context.Context, manifest release.Manifest) error {
	if err := m.RequireSupervisor(); err != nil {
		return err
	}
	return m.activateLauncher(manifest)
}
func (m *Manager) AcknowledgeStartup() error                    { return m.acknowledgeLauncher() }
func (m *Manager) AwaitStartupCommit(ctx context.Context) error { return m.awaitLauncher(ctx) }
func (m *Manager) PendingActivation() (bool, error) {
	s, err := m.readLauncher()
	return !s.BootReady, err
}
func (m *Manager) ActivationCommitted(manifest release.Manifest) (bool, error) {
	s, err := m.readLauncher()
	if err != nil {
		return false, err
	}
	artifact, ok := manifest.Manager.Artifacts[runtime.GOARCH]
	return ok && s.Proven && !s.Pending && !s.Failed && s.Selected.SourceCommit == manifest.SourceCommit && s.Selected.Version == manifest.Manager.Version && s.Selected.SHA256 == artifact.SHA256, nil
}
func (m *Manager) ActivationRolledBack(manifest release.Manifest) (bool, error) {
	s, err := m.readLauncher()
	return s.Rejected == manifest.SourceCommit && !s.Pending && s.Selected.SourceCommit != manifest.SourceCommit, err
}
func (m *Manager) State() (State, error) { return m.load() }

func (m *Manager) ensureVersionMetadata(version Version) error {
	root, err := filepath.Abs(filepath.Join(m.Root, "versions"))
	if err != nil {
		return err
	}
	rootInfo, err := os.Lstat(root)
	if err != nil || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("Manager version root is not a regular directory")
	}
	path, err := filepath.Abs(filepath.Clean(version.Path))
	if err != nil {
		return err
	}
	if filepath.Dir(filepath.Dir(path)) != root || filepath.Base(path) != m.managerBinaryName() {
		return errors.New("referenced Manager version is outside the version root")
	}
	dir := filepath.Dir(path)
	dirInfo, err := os.Lstat(dir)
	if err != nil || !dirInfo.IsDir() || dirInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("referenced Manager version directory is not a regular directory")
	}
	if !validVersionDirectoryIdentity(filepath.Base(dir), version) || !validSHA256(version.SHA256) {
		return errors.New("referenced Manager version identity is invalid")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("referenced Manager version is not a regular file")
	}
	digest, err := fileSHA256(path)
	if err != nil {
		return err
	}
	if digest != version.SHA256 {
		return errors.New("referenced Manager version checksum changed")
	}
	version.Path = path
	if version.VerifiedAt.IsZero() {
		version.VerifiedAt = m.now()
	}
	if err := atomicfile.WriteJSON(filepath.Join(dir, "metadata.json"), version, 0o600); err != nil {
		return err
	}
	return validateVersionDirectoryContents(dir, m.managerBinaryName())
}

func validateVersionDirectoryContents(dir, managerBinaryName string) error {
	contents, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	allowed := map[string]struct{}{managerBinaryName: {}, "metadata.json": {}}
	if len(contents) != len(allowed) {
		return errors.New("Manager version directory contains unknown files")
	}
	for _, content := range contents {
		if _, ok := allowed[content.Name()]; !ok {
			return fmt.Errorf("unknown file in Manager version directory: %s", content.Name())
		}
		info, err := os.Lstat(filepath.Join(dir, content.Name()))
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("Manager version content %s is not a regular file", content.Name())
		}
	}
	return nil
}

func validVersionDirectoryIdentity(name string, version Version) bool {
	if !validSHA256(version.SHA256) {
		return false
	}
	if name == "running-"+version.SHA256[:12] || name == "recovery-"+version.SHA256[:12] {
		return true
	}
	if !validSourceCommit(version.SourceCommit) {
		return false
	}
	return name == safeID(version.Version+"-"+version.SourceCommit[:12])
}

func (m *Manager) validateStartupVersionArtifact(v Version, label string) error {
	data, _, err := readRecoveryRegularFile(v.Path, recoveryMaxBinaryBytes, false)
	if err != nil || sha256Hex(data) != v.SHA256 {
		return fmt.Errorf("%s Manager artifact checksum invalid", label)
	}
	if !validVersionDirectoryIdentity(filepath.Base(filepath.Dir(v.Path)), v) {
		return errors.New("invalid version directory identity")
	}
	data, _, err = readRecoveryRegularFile(filepath.Join(filepath.Dir(v.Path), "metadata.json"), recoveryMaxJSONBytes, true)
	if err != nil {
		return err
	}
	var metadata Version
	if err := decodeRecoveryJSON(data, &metadata); err != nil {
		return err
	}
	if metadata.Version != v.Version || metadata.SourceCommit != v.SourceCommit || metadata.Path != v.Path || metadata.SHA256 != v.SHA256 || !metadata.VerifiedAt.Equal(v.VerifiedAt) {
		return errors.New("Manager metadata identity mismatch")
	}
	return validateVersionDirectoryContents(filepath.Dir(v.Path), m.managerBinaryName())
}
func (m *Manager) load() (State, error) {
	var state State
	data, _, err := readRecoveryRegularFile(m.StatePath, recoveryMaxJSONBytes, true)
	if err != nil {
		return state, err
	}
	if err := decodeRecoveryJSON(data, &state); err != nil {
		return state, err
	}
	if state.SchemaVersion != 1 {
		return state, errors.New("unsupported Manager binary state")
	}
	return state, nil
}
func (m *Manager) runner() Runner {
	if m.Runner != nil {
		return m.Runner
	}
	return CommandRunner{}
}
func (m *Manager) now() time.Time {
	if m.Now != nil {
		return m.Now().UTC()
	}
	return time.Now().UTC()
}
func managerHealthy(ctx context.Context, socketPath, tokenFile, expectedVersion, expectedSHA string) bool {
	return recoveryManagerIdentityMatches(ctx, socketPath, tokenFile, expectedVersion, expectedSHA)
}

func binaryMatches(path, expected string) bool {
	actual, err := fileSHA256(path)
	return err == nil && actual == expected
}
func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, io.LimitReader(f, (128<<20)+1))
	if err != nil {
		return "", err
	}
	if size > 128<<20 {
		return "", errors.New("Manager executable exceeds checksum size limit")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
func sha256Hex(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}
func safeID(value string) string {
	var b strings.Builder
	for _, r := range value {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-' {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	result := strings.Trim(b.String(), "-")
	if result == "" {
		return "unknown"
	}
	if len(result) > 120 {
		return result[:120]
	}
	return result
}

func (m *Manager) PruneVersions(ctx context.Context, now time.Time, retention time.Duration) (int, error) {
	if retention <= 0 {
		retention = 7 * 24 * time.Hour
	}
	releaseRecoveryLock, err := acquireRecoveryLock(m.Root)
	if err != nil {
		return 0, fmt.Errorf("coordinate Manager binary cleanup with recovery: %w", err)
	}
	defer releaseRecoveryLock()
	state, err := m.load()
	if err != nil {
		return 0, err
	}
	launcher, err := m.readLauncher()
	if err != nil {
		return 0, err
	}
	if len(state.Activation) != 0 && string(state.Activation) != "null" {
		return 0, errors.New("legacy activation blocks cleanup")
	}
	protected := map[string]struct{}{}
	for _, item := range []*Version{state.Current, state.Previous, state.Candidate} {
		if item == nil || item.Path == "" {
			continue
		}
		path, pathErr := filepath.Abs(filepath.Clean(item.Path))
		if pathErr != nil {
			return 0, pathErr
		}
		protected[path] = struct{}{}
		if err := m.ensureVersionMetadata(*item); err != nil {
			return 0, err
		}
	}
	for _, v := range []*Version{&launcher.Selected, launcher.Previous} {
		if v != nil {
			protected[v.Path] = struct{}{}
		}
	}
	root, err := filepath.Abs(filepath.Join(m.Root, "versions"))
	if err != nil {
		return 0, err
	}
	entries, err := os.ReadDir(root)
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, entry := range entries {
		select {
		case <-ctx.Done():
			return removed, ctx.Err()
		default:
		}
		if entry.Type()&os.ModeSymlink != 0 || !entry.IsDir() || safeID(entry.Name()) != entry.Name() {
			continue
		}
		dir := filepath.Join(root, entry.Name())
		binary := filepath.Join(dir, m.managerBinaryName())
		if _, keep := protected[binary]; keep {
			continue
		}
		var metadata Version
		if err := atomicfile.ReadJSON(filepath.Join(dir, "metadata.json"), &metadata); err != nil {
			continue
		}
		if !validVersionDirectoryIdentity(entry.Name(), metadata) || !filepath.IsAbs(metadata.Path) || filepath.Clean(metadata.Path) != binary || metadata.VerifiedAt.IsZero() || now.Sub(metadata.VerifiedAt) <= retention {
			continue
		}
		if err := validateVersionDirectoryContents(dir, m.managerBinaryName()); err != nil {
			continue
		}
		digest, err := fileSHA256(binary)
		if err != nil || digest != metadata.SHA256 || !validSHA256(metadata.SHA256) {
			continue
		}
		// Repeat the exact-content and checksum checks immediately before the
		// recursive removal. Unknown evidence appearing during maintenance is a
		// reason to retain the directory, never a reason to delete it.
		var latest Version
		if err := atomicfile.ReadJSON(filepath.Join(dir, "metadata.json"), &latest); err != nil || latest != metadata {
			continue
		}
		if err := validateVersionDirectoryContents(dir, m.managerBinaryName()); err != nil {
			continue
		}
		if latestDigest, err := fileSHA256(binary); err != nil || latestDigest != metadata.SHA256 {
			continue
		}
		if err := os.RemoveAll(dir); err != nil {
			return removed, err
		}
		removed++
	}
	if removed > 0 {
		directory, err := os.Open(root)
		if err != nil {
			return removed, err
		}
		err = directory.Sync()
		_ = directory.Close()
		if err != nil {
			return removed, fmt.Errorf("sync Manager version root after cleanup: %w", err)
		}
	}
	return removed, nil
}
