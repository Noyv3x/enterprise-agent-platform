package sandbox

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/config"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

type Record struct {
	SandboxID       string     `json:"sandbox_id"`
	SandboxHash     string     `json:"sandbox_hash"`
	WorkspaceID     string     `json:"workspace_id"`
	Profile         string     `json:"profile,omitempty"`
	UID             int        `json:"uid"`
	GID             int        `json:"gid"`
	WorkspacePath   string     `json:"workspace_path"`
	HomePath        string     `json:"home_path"`
	EnvironmentPath string     `json:"environment_path"`
	AttachmentsPath string     `json:"attachments_path"`
	ContainerName   string     `json:"container_name"`
	Image           string     `json:"image"`
	LastActivityAt  time.Time  `json:"last_activity_at"`
	ActiveCalls     int        `json:"active_calls"`
	StoppedAt       *time.Time `json:"stopped_at,omitempty"`
}

type registry struct {
	SchemaVersion    int               `json:"schema_version"`
	TechnicalProfile string            `json:"technical_profile"`
	Records          map[string]Record `json:"records"`
}

type Manager struct {
	Engine         driver.Engine
	DataDir        string
	StatePath      string
	Image          string
	Network        string
	Idle           time.Duration
	AgentResources config.SandboxResources
	ChatResources  config.SandboxResources
	ChatIdle       time.Duration
	UID, GID       int
	// ReclaimCapacity performs one controlled maintenance pass before a missing
	// Sandbox image is retried, before acquiring any sandbox lifecycle lock.
	ReclaimCapacity func(context.Context) error
	// OnStopped is told after a sandbox is stopped outside the startup barrier
	// so supervised background processes can record sandbox_stopped.
	OnStopped  func(sandboxID string)
	mu         sync.Mutex
	registry   registry
	ensureMu   sync.Mutex
	ensureByID map[string]*sync.Mutex
	profile    identity.Profile
}

func Open(active identity.ActiveProfile, engine driver.Engine, dataDir, statePath, image, network string, idle time.Duration) (*Manager, error) {
	profile, err := active.Profile()
	if err != nil {
		return nil, fmt.Errorf("Sandbox technical profile: %w", err)
	}
	manager := &Manager{Engine: engine, DataDir: filepath.Clean(dataDir), StatePath: statePath, Image: image, Network: network, Idle: idle, UID: os.Getuid(), GID: os.Getgid(), registry: registry{SchemaVersion: sandboxRegistrySchemaVersion, TechnicalProfile: profile.ProfileID, Records: map[string]Record{}}, ensureByID: map[string]*sync.Mutex{}, profile: profile}
	manager.AgentResources = config.SandboxResources{Memory: "2g", MemorySwap: "2g", CPUs: "2", PidsLimit: 1024}
	manager.ChatResources = config.SandboxResources{Memory: "768m", MemorySwap: "768m", CPUs: "1", PidsLimit: 256}
	manager.ChatIdle = 3 * time.Minute
	if err := manager.loadRegistry(); err != nil {
		return nil, err
	}
	if err := manager.validateRegistry(); err != nil {
		return nil, err
	}
	return manager, nil
}

func (m *Manager) Ensure(ctx context.Context, sandboxID, workspaceID string, now time.Time, profiles ...string) (driver.SandboxSpec, error) {
	requested := ""
	if len(profiles) > 1 {
		return driver.SandboxSpec{}, errors.New("only one sandbox profile is allowed")
	}
	if len(profiles) == 1 {
		requested = profiles[0]
	}
	resourceProfile, err := NormalizeProfile(requested)
	if err != nil {
		return driver.SandboxSpec{}, err
	}
	if err := validateWorkspaceProfile(workspaceID, resourceProfile); err != nil {
		return driver.SandboxSpec{}, err
	}
	if sandboxID == "" {
		return driver.SandboxSpec{}, errors.New("sandbox_id is required")
	}
	m.mu.Lock()
	desiredImage := m.Image
	m.mu.Unlock()
	if desiredImage == "" {
		return driver.SandboxSpec{}, errors.New("sandbox image is not configured")
	}
	if preparer, ok := m.Engine.(driver.ManagedImagePreparer); ok {
		prepareErr := preparer.PrepareManagedImage(ctx, "agent-sandbox", desiredImage)
		if driver.IsInsufficientCapacity(prepareErr) && m.ReclaimCapacity != nil {
			if reclaimErr := m.ReclaimCapacity(ctx); reclaimErr != nil {
				return driver.SandboxSpec{}, errors.Join(prepareErr, fmt.Errorf("reclaim capacity before sandbox image retry: %w", reclaimErr))
			}
			prepareErr = preparer.PrepareManagedImage(ctx, "agent-sandbox", desiredImage)
		}
		if prepareErr != nil {
			return driver.SandboxSpec{}, fmt.Errorf("prepare sandbox image: %w", prepareErr)
		}
	}
	m.mu.Lock()
	imageStillCurrent := m.Image == desiredImage
	m.mu.Unlock()
	if !imageStillCurrent {
		return m.Ensure(ctx, sandboxID, workspaceID, now, resourceProfile)
	}
	unlock := m.lockEnsure(sandboxID)
	defer unlock()

	m.mu.Lock()
	existing, exists := m.registry.Records[sandboxID]
	image, network, uid, gid := m.Image, m.Network, m.UID, m.GID
	m.mu.Unlock()
	if exists && existing.WorkspaceID != workspaceID {
		return driver.SandboxSpec{}, fmt.Errorf("sandbox_id %q is already bound to workspace_id %q", sandboxID, existing.WorkspaceID)
	}
	if exists {
		existingProfile, err := NormalizeProfile(existing.Profile)
		if err != nil || existingProfile != resourceProfile {
			return driver.SandboxSpec{}, fmt.Errorf("sandbox_id %q is already bound to profile %q", sandboxID, existingProfile)
		}
	}
	workspacePath, err := m.workspacePath(workspaceID)
	if err != nil {
		return driver.SandboxSpec{}, err
	}
	hash := stableHash(sandboxID)
	binding, err := m.expectedBinding(workspaceID, hash)
	if err != nil {
		return driver.SandboxSpec{}, err
	}
	envRoot := filepath.Join(m.DataDir, "agent-envs", hash)
	spec := driver.SandboxSpec{ContainerName: m.profile.SandboxContainerPrefix + hash[:16], AgentHash: hash, Image: image, Network: network, Workspace: workspacePath, Home: filepath.Join(envRoot, "home"), Environment: filepath.Join(envRoot, "env"), UID: uid, GID: gid}
	m.applyResources(&spec, resourceProfile)
	if attachmentPath, ok := m.attachmentPath(workspaceID); ok {
		spec.Attachments = attachmentPath
	}
	if spec.Image == "" {
		return driver.SandboxSpec{}, errors.New("sandbox image is not configured")
	}
	paths := []string{spec.Workspace, spec.Home, spec.Environment, filepath.Join(envRoot, "logs")}
	if spec.Attachments != "" {
		paths = append(paths, filepath.Join(spec.Workspace, m.profile.InternalWorkspaceDirectory, "attachments"), spec.Attachments)
	}
	for _, path := range paths {
		if err := ensureOwnedDirectoryBelow(m.DataDir, path, uid, gid); err != nil {
			return driver.SandboxSpec{}, fmt.Errorf("prepare sandbox bind root %s: %w", path, err)
		}
	}

	var replacement *replacementState
	if exists && existing.Image != "" && existing.Image != spec.Image {
		if existing.ActiveCalls > 0 {
			// A busy sandbox remains pinned to its recorded digest. The next Ensure
			// after its active calls drain will perform the replacement.
			spec.Image = existing.Image
		} else {
			wasRunning, runningErr := m.Engine.SandboxRunning(ctx, existing.ContainerName)
			if runningErr != nil {
				return driver.SandboxSpec{}, fmt.Errorf("inspect stale sandbox image: %w", runningErr)
			}
			oldSpec, oldSpecErr := m.specForRecord(existing)
			if oldSpecErr != nil {
				return driver.SandboxSpec{}, oldSpecErr
			}
			if err := m.Engine.StopSandbox(ctx, existing.ContainerName); err != nil {
				return driver.SandboxSpec{}, fmt.Errorf("stop stale sandbox image: %w", err)
			}
			if m.OnStopped != nil {
				m.OnStopped(sandboxID)
			}
			if err := m.Engine.RemoveSandbox(ctx, existing.ContainerName); err != nil {
				return driver.SandboxSpec{}, fmt.Errorf("remove stale sandbox image: %w", err)
			}
			replacement = &replacementState{spec: oldSpec, wasRunning: wasRunning}
		}
	}
	outcome, err := ensureSandbox(ctx, m.Engine, spec)
	if err != nil {
		rollbackErr := rollbackEnsure(ctx, m.Engine, spec, outcome)
		if replacement != nil {
			rollbackErr = errors.Join(rollbackErr, m.restoreReplacement(ctx, *replacement))
		}
		return driver.SandboxSpec{}, errors.Join(err, rollbackErr)
	}
	m.mu.Lock()
	record := m.registry.Records[sandboxID]
	record.SandboxID, record.SandboxHash, record.WorkspaceID, record.ContainerName, record.Image = sandboxID, hash, workspaceID, spec.ContainerName, spec.Image
	if resourceProfile == "chat" {
		record.Profile = "chat"
	}
	record.UID, record.GID = binding.UID, binding.GID
	record.WorkspacePath, record.HomePath = binding.WorkspacePath, binding.HomePath
	record.EnvironmentPath, record.AttachmentsPath = binding.EnvironmentPath, binding.AttachmentsPath
	record.LastActivityAt, record.StoppedAt = now.UTC(), nil
	m.registry.Records[sandboxID] = record
	persistErr := m.persistLocked()
	if persistErr != nil {
		if exists {
			m.registry.Records[sandboxID] = existing
		} else {
			delete(m.registry.Records, sandboxID)
		}
	}
	m.mu.Unlock()
	if persistErr != nil {
		rollbackErr := rollbackEnsure(ctx, m.Engine, spec, outcome)
		if replacement != nil {
			rollbackErr = errors.Join(rollbackErr, m.restoreReplacement(ctx, *replacement))
		}
		return driver.SandboxSpec{}, errors.Join(fmt.Errorf("persist sandbox registry: %w", persistErr), rollbackErr)
	}
	return spec, nil
}

func (m *Manager) BeginCall(sandboxID string, now time.Time) error {
	unlock := m.lockEnsure(sandboxID)
	defer unlock()
	m.mu.Lock()
	defer m.mu.Unlock()
	record, ok := m.registry.Records[sandboxID]
	if !ok {
		return errors.New("sandbox is not registered")
	}
	original := record
	record.ActiveCalls++
	record.LastActivityAt = now.UTC()
	record.StoppedAt = nil
	m.registry.Records[sandboxID] = record
	if err := m.persistLocked(); err != nil {
		m.registry.Records[sandboxID] = original
		return err
	}
	return nil
}
func (m *Manager) EndCall(sandboxID string, now time.Time) error {
	unlock := m.lockEnsure(sandboxID)
	defer unlock()
	m.mu.Lock()
	defer m.mu.Unlock()
	record, ok := m.registry.Records[sandboxID]
	if !ok {
		return errors.New("sandbox is not registered")
	}
	if record.ActiveCalls > 0 {
		record.ActiveCalls--
	}
	record.LastActivityAt = now.UTC()
	m.registry.Records[sandboxID] = record
	return m.persistLocked()
}

func (m *Manager) Reap(ctx context.Context, now time.Time) ([]string, error) {
	m.mu.Lock()
	candidates := make([]Record, 0)
	for _, record := range m.registry.Records {
		if record.StoppedAt == nil && record.ActiveCalls == 0 && now.Sub(record.LastActivityAt) >= m.idleFor(record.Profile) {
			candidates = append(candidates, record)
		}
	}
	m.mu.Unlock()
	stopped := make([]string, 0, len(candidates))
	for _, record := range candidates {
		unlock := m.lockEnsure(record.SandboxID)
		m.mu.Lock()
		current, exists := m.registry.Records[record.SandboxID]
		eligible := exists && current.StoppedAt == nil && current.ActiveCalls == 0 && now.Sub(current.LastActivityAt) >= m.idleFor(current.Profile)
		m.mu.Unlock()
		if !eligible {
			unlock()
			continue
		}
		if err := m.Engine.StopSandbox(ctx, record.ContainerName); err != nil {
			unlock()
			return stopped, err
		}
		if m.OnStopped != nil {
			m.OnStopped(record.SandboxID)
		}
		m.mu.Lock()
		original := m.registry.Records[record.SandboxID]
		timestamp := now.UTC()
		current.StoppedAt = &timestamp
		m.registry.Records[record.SandboxID] = current
		persistErr := m.persistLocked()
		if persistErr != nil {
			m.registry.Records[record.SandboxID] = original
		}
		m.mu.Unlock()
		unlock()
		if persistErr != nil {
			return stopped, fmt.Errorf("persist stopped sandbox state: %w", persistErr)
		}
		stopped = append(stopped, record.SandboxID)
	}
	return stopped, nil
}

// ReconcileImages retires stopped, idle Sandbox containers that still pin an
// obsolete digest. Persistent workspaces and Agent homes are bind mounts and
// remain untouched; the next Ensure recreates the ephemeral container from the
// current digest. Unknown or running containers are retained.
func (m *Manager) ReconcileImages(ctx context.Context, now time.Time) ([]string, error) {
	m.mu.Lock()
	desired := m.Image
	candidates := make([]Record, 0)
	for _, record := range m.registry.Records {
		if desired != "" && record.Image != desired && record.ActiveCalls == 0 {
			candidates = append(candidates, record)
		}
	}
	m.mu.Unlock()
	if len(candidates) == 0 {
		return nil, nil
	}
	retirer, ok := m.Engine.(driver.ManagedSandboxRetirer)
	if !ok {
		return nil, errors.New("sandbox engine cannot prove stopped-container ownership")
	}
	updated := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		select {
		case <-ctx.Done():
			return updated, ctx.Err()
		default:
		}
		unlock := m.lockEnsure(candidate.SandboxID)
		m.mu.Lock()
		current, exists := m.registry.Records[candidate.SandboxID]
		desired = m.Image
		eligible := exists && desired != "" && current.Image != desired && current.ActiveCalls == 0
		m.mu.Unlock()
		if !eligible {
			unlock()
			continue
		}
		state, err := retirer.InspectManagedSandbox(ctx, current.ContainerName, current.SandboxHash)
		if err != nil {
			unlock()
			return updated, err
		}
		if state.Exists && (!state.Owned || state.Running) {
			unlock()
			continue
		}
		if state.Exists {
			if err := retirer.RemoveStoppedManagedSandbox(ctx, current.ContainerName, current.SandboxHash); err != nil {
				unlock()
				return updated, err
			}
		}
		m.mu.Lock()
		latest, stillExists := m.registry.Records[candidate.SandboxID]
		if !stillExists || latest.ActiveCalls != 0 || latest.Image == desired {
			m.mu.Unlock()
			unlock()
			continue
		}
		original := latest
		latest.Image = desired
		if latest.StoppedAt == nil {
			stoppedAt := now.UTC()
			latest.StoppedAt = &stoppedAt
		}
		m.registry.Records[candidate.SandboxID] = latest
		persistErr := m.persistLocked()
		if persistErr != nil {
			m.registry.Records[candidate.SandboxID] = original
		}
		m.mu.Unlock()
		unlock()
		if persistErr != nil {
			return updated, fmt.Errorf("persist refreshed sandbox image: %w", persistErr)
		}
		updated = append(updated, candidate.SandboxID)
	}
	return updated, nil
}

func (m *Manager) Spec(sandboxID string) (driver.SandboxSpec, error) {
	m.mu.Lock()
	record, ok := m.registry.Records[sandboxID]
	m.mu.Unlock()
	if !ok {
		return driver.SandboxSpec{}, errors.New("sandbox is not registered")
	}
	return m.specForRecord(record)
}

func (m *Manager) Records() []Record {
	m.mu.Lock()
	defer m.mu.Unlock()
	records := make([]Record, 0, len(m.registry.Records))
	for _, record := range m.registry.Records {
		records = append(records, record)
	}
	return records
}

// StopRunning is a startup barrier, called before accepting executor requests.
// The engine must discover all managed containers, including those absent from
// the registry, and prove they stopped before stale call accounting is cleared.
// Persistent workspace, home and environment directories remain untouched.
func (m *Manager) StopRunning(ctx context.Context) error {
	stopper, ok := m.Engine.(interface {
		StopRunningManagedSandboxes(context.Context) error
	})
	if !ok {
		return errors.New("sandbox engine cannot stop all running managed containers")
	}
	if err := stopper.StopRunningManagedSandboxes(ctx); err != nil {
		return fmt.Errorf("stop running managed sandboxes: %w", err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	previous := m.registry.Records
	m.registry.Records = make(map[string]Record, len(previous))
	now := time.Now().UTC()
	for id, record := range previous {
		record.ActiveCalls = 0
		record.StoppedAt = &now
		m.registry.Records[id] = record
	}
	if err := m.persistLocked(); err != nil {
		m.registry.Records = previous
		return fmt.Errorf("persist stopped sandbox accounting: %w", err)
	}
	return nil
}
func (m *Manager) SetImage(image string) {
	if image == "" {
		return
	}
	m.mu.Lock()
	m.Image = image
	m.mu.Unlock()
}

func (m *Manager) validateRegistry() error {
	if m.registry.SchemaVersion != sandboxRegistrySchemaVersion {
		return fmt.Errorf("unsupported sandbox registry schema %d", m.registry.SchemaVersion)
	}
	if m.registry.TechnicalProfile != m.profile.ProfileID {
		return fmt.Errorf("sandbox registry technical profile %q does not match active profile %q", m.registry.TechnicalProfile, m.profile.ProfileID)
	}
	if m.registry.Records == nil {
		return errors.New("sandbox registry records must be an object")
	}
	for key, record := range m.registry.Records {
		if key == "" || record.SandboxID != key {
			return fmt.Errorf("sandbox registry key %q does not match record identity %q", key, record.SandboxID)
		}
		hash := stableHash(key)
		if record.SandboxHash != hash {
			return fmt.Errorf("sandbox registry %q has an invalid identity hash", key)
		}
		if record.ContainerName != m.profile.SandboxContainerPrefix+hash[:16] {
			return fmt.Errorf("sandbox registry %q has an invalid container name", key)
		}
		if _, err := m.workspacePath(record.WorkspaceID); err != nil {
			return fmt.Errorf("sandbox registry %q has an invalid workspace binding: %w", key, err)
		}
		expected, err := m.expectedBinding(record.WorkspaceID, record.SandboxHash)
		if err != nil {
			return fmt.Errorf("sandbox registry %q has an invalid persistent binding: %w", key, err)
		}
		actual := bindingFromRecord(record)
		if actual != expected {
			return fmt.Errorf("sandbox registry %q persistent binding does not match the trusted data layout", key)
		}
		resourceProfile, err := NormalizeProfile(record.Profile)
		if err != nil {
			return err
		}
		if err := validateWorkspaceProfile(record.WorkspaceID, resourceProfile); err != nil {
			return err
		}
		for _, relative := range expected.relativePaths() {
			path, err := m.dataPath(relative)
			if err != nil {
				return fmt.Errorf("sandbox registry %q has an invalid persisted path: %w", key, err)
			}
			if err := validateOwnedDirectoryBelow(m.DataDir, path, record.UID, record.GID); err != nil {
				return fmt.Errorf("sandbox registry %q persistent directory %q is invalid: %w", key, relative, err)
			}
		}
	}
	return nil
}

func (m *Manager) lockEnsure(sandboxID string) func() {
	m.ensureMu.Lock()
	lock := m.ensureByID[sandboxID]
	if lock == nil {
		lock = &sync.Mutex{}
		m.ensureByID[sandboxID] = lock
	}
	m.ensureMu.Unlock()
	lock.Lock()
	return lock.Unlock
}

func (m *Manager) specForRecord(record Record) (driver.SandboxSpec, error) {
	if err := m.validateRecordBinding(record); err != nil {
		return driver.SandboxSpec{}, err
	}
	workspace, err := m.dataPath(record.WorkspacePath)
	if err != nil {
		return driver.SandboxSpec{}, err
	}
	home, err := m.dataPath(record.HomePath)
	if err != nil {
		return driver.SandboxSpec{}, err
	}
	environment, err := m.dataPath(record.EnvironmentPath)
	if err != nil {
		return driver.SandboxSpec{}, err
	}
	attachments := ""
	if record.AttachmentsPath != "" {
		attachments, err = m.dataPath(record.AttachmentsPath)
		if err != nil {
			return driver.SandboxSpec{}, err
		}
	}
	spec := driver.SandboxSpec{ContainerName: record.ContainerName, AgentHash: record.SandboxHash, Image: record.Image, Network: m.Network, Workspace: workspace, Home: home, Environment: environment, Attachments: attachments, UID: record.UID, GID: record.GID}
	m.applyResources(&spec, record.Profile)
	return spec, nil
}

type replacementState struct {
	spec       driver.SandboxSpec
	wasRunning bool
}

type resultEngine interface {
	EnsureSandboxWithResult(context.Context, driver.SandboxSpec) (driver.SandboxEnsureResult, error)
}

func ensureSandbox(ctx context.Context, engine driver.Engine, spec driver.SandboxSpec) (driver.SandboxEnsureResult, error) {
	if precise, ok := engine.(resultEngine); ok {
		return precise.EnsureSandboxWithResult(ctx, spec)
	}
	wasRunning, inspectErr := engine.SandboxRunning(ctx, spec.ContainerName)
	if err := engine.EnsureSandbox(ctx, spec); err != nil {
		return driver.SandboxEnsureResult{}, err
	}
	if inspectErr != nil {
		return driver.SandboxEnsureResult{Created: true, Started: true}, nil
	}
	if wasRunning {
		return driver.SandboxEnsureResult{WasRunning: true}, nil
	}
	return driver.SandboxEnsureResult{Started: true}, nil
}

func rollbackEnsure(ctx context.Context, engine driver.Engine, spec driver.SandboxSpec, outcome driver.SandboxEnsureResult) error {
	if outcome.WasRunning || (!outcome.Created && !outcome.Started) {
		return nil
	}
	rollbackCtx, cancel := compensationContext(ctx)
	defer cancel()
	var rollbackErr error
	if outcome.Started {
		if err := engine.StopSandbox(rollbackCtx, spec.ContainerName); err != nil {
			rollbackErr = errors.Join(rollbackErr, fmt.Errorf("stop uncommitted sandbox: %w", err))
		}
	}
	if outcome.Created {
		if err := engine.RemoveSandbox(rollbackCtx, spec.ContainerName); err != nil {
			rollbackErr = errors.Join(rollbackErr, fmt.Errorf("remove uncommitted sandbox: %w", err))
		}
	}
	return rollbackErr
}

func (m *Manager) restoreReplacement(ctx context.Context, replacement replacementState) error {
	restoreCtx, cancel := compensationContext(ctx)
	defer cancel()
	outcome, err := ensureSandbox(restoreCtx, m.Engine, replacement.spec)
	if err != nil {
		return fmt.Errorf("restore previous sandbox image: %w", err)
	}
	if !replacement.wasRunning && (outcome.Created || outcome.Started) {
		if err := m.Engine.StopSandbox(restoreCtx, replacement.spec.ContainerName); err != nil {
			return fmt.Errorf("restore previous stopped sandbox state: %w", err)
		}
	}
	return nil
}

func compensationContext(parent context.Context) (context.Context, context.CancelFunc) {
	if parent.Err() == nil {
		return context.WithTimeout(parent, 30*time.Second)
	}
	return context.WithTimeout(context.Background(), 30*time.Second)
}

func (m *Manager) workspacePath(id string) (string, error) {
	if id == "" {
		return "", errors.New("workspace_id is required")
	}
	if strings.HasPrefix(id, "chat-user-") {
		user := strings.TrimPrefix(id, "chat-user-")
		if !safeSegment(user) {
			return "", errors.New("invalid chat workspace_id")
		}
		return filepath.Join(m.DataDir, "workspaces", "chat", "user-"+user), nil
	}
	clean := filepath.Clean(id)
	if filepath.IsAbs(clean) || clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errors.New("workspace_id must be a relative path")
	}
	for _, part := range strings.Split(clean, string(filepath.Separator)) {
		if part == "" || part == "." || part == ".." {
			return "", errors.New("workspace_id contains an invalid path segment")
		}
	}
	return filepath.Join(m.DataDir, "workspaces", clean), nil
}
func (m *Manager) attachmentPath(workspaceID string) (string, bool) {
	relative, ok := attachmentRelativePath(workspaceID)
	if !ok {
		return "", false
	}
	return filepath.Join(m.DataDir, filepath.FromSlash(relative)), true
}
func safeSegment(value string) bool {
	for _, r := range value {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r == '_' || r == '-') {
			return false
		}
	}
	return value != ""
}
func (m *Manager) persistLocked() error {
	return atomicfile.WriteJSON(m.StatePath, m.registry, 0o600)
}
func stableHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
