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

	"github.com/ubitech/agent-platform/manager/internal/atomicfile"
	"github.com/ubitech/agent-platform/manager/internal/contract"
	"github.com/ubitech/agent-platform/manager/internal/driver"
)

type Record struct {
	SandboxID           string     `json:"sandbox_id"`
	SandboxHash         string     `json:"sandbox_hash"`
	WorkspaceID         string     `json:"workspace_id"`
	ContainerName       string     `json:"container_name"`
	Image               string     `json:"image"`
	LastActivityAt      time.Time  `json:"last_activity_at"`
	ActiveCalls         int        `json:"active_calls"`
	BackgroundProcesses int        `json:"background_processes"`
	StoppedAt           *time.Time `json:"stopped_at,omitempty"`
}

type registry struct {
	SchemaVersion int               `json:"schema_version"`
	Records       map[string]Record `json:"records"`
}

type Manager struct {
	Engine     driver.Engine
	DataDir    string
	StatePath  string
	Image      string
	Network    string
	Idle       time.Duration
	UID, GID   int
	mu         sync.Mutex
	registry   registry
	ensureMu   sync.Mutex
	ensureByID map[string]*sync.Mutex
}

func Open(engine driver.Engine, dataDir, statePath, image, network string, idle time.Duration) (*Manager, error) {
	manager := &Manager{Engine: engine, DataDir: dataDir, StatePath: statePath, Image: image, Network: network, Idle: idle, UID: os.Getuid(), GID: os.Getgid(), registry: registry{SchemaVersion: 1, Records: map[string]Record{}}, ensureByID: map[string]*sync.Mutex{}}
	if err := atomicfile.ReadJSON(statePath, &manager.registry); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if manager.registry.SchemaVersion != 1 {
		return nil, fmt.Errorf("unsupported sandbox registry schema %d", manager.registry.SchemaVersion)
	}
	if manager.registry.Records == nil {
		manager.registry.Records = map[string]Record{}
	}
	if err := manager.validateRegistry(); err != nil {
		return nil, err
	}
	return manager, nil
}

func (m *Manager) Ensure(ctx context.Context, sandboxID, workspaceID string, now time.Time) (driver.SandboxSpec, error) {
	if sandboxID == "" {
		return driver.SandboxSpec{}, errors.New("sandbox_id is required")
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
	workspacePath, err := m.workspacePath(workspaceID)
	if err != nil {
		return driver.SandboxSpec{}, err
	}
	hash := stableHash(sandboxID)
	envRoot := filepath.Join(m.DataDir, "agent-envs", hash)
	spec := driver.SandboxSpec{ContainerName: "ubitech-sandbox-" + hash[:16], AgentHash: hash, Image: image, Network: network, Workspace: workspacePath, Home: filepath.Join(envRoot, "home"), Environment: filepath.Join(envRoot, "env"), UID: uid, GID: gid}
	if attachmentPath, ok := m.attachmentPath(workspaceID); ok {
		spec.Attachments = attachmentPath
	}
	if spec.Image == "" {
		return driver.SandboxSpec{}, errors.New("sandbox image is not configured")
	}
	paths := []string{spec.Workspace, spec.Home, spec.Environment, filepath.Join(envRoot, "logs")}
	if spec.Attachments != "" {
		paths = append(paths, spec.Attachments)
	}
	for _, path := range paths {
		if err := ensureOwnedDirectoryBelow(m.DataDir, path, uid, gid); err != nil {
			return driver.SandboxSpec{}, fmt.Errorf("prepare sandbox bind root %s: %w", path, err)
		}
	}

	var replacement *replacementState
	if exists && existing.Image != "" && existing.Image != spec.Image {
		if existing.ActiveCalls > 0 || existing.BackgroundProcesses > 0 {
			// A busy sandbox remains pinned to its recorded digest. The next Ensure
			// after its managed processes drain will perform the replacement.
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
	record.ActiveCalls++
	record.LastActivityAt = now.UTC()
	record.StoppedAt = nil
	m.registry.Records[sandboxID] = record
	return m.persistLocked()
}
func (m *Manager) EndCall(sandboxID string, backgroundStarted bool, now time.Time) error {
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
	if backgroundStarted {
		record.BackgroundProcesses++
	}
	record.LastActivityAt = now.UTC()
	m.registry.Records[sandboxID] = record
	return m.persistLocked()
}
func (m *Manager) ProcessExited(sandboxID string, now time.Time) error {
	unlock := m.lockEnsure(sandboxID)
	defer unlock()
	m.mu.Lock()
	defer m.mu.Unlock()
	record, ok := m.registry.Records[sandboxID]
	if !ok {
		return errors.New("sandbox is not registered")
	}
	if record.BackgroundProcesses > 0 {
		record.BackgroundProcesses--
	}
	record.LastActivityAt = now.UTC()
	m.registry.Records[sandboxID] = record
	return m.persistLocked()
}
func (m *Manager) Touch(sandboxID string, now time.Time) error {
	unlock := m.lockEnsure(sandboxID)
	defer unlock()
	m.mu.Lock()
	defer m.mu.Unlock()
	record, ok := m.registry.Records[sandboxID]
	if !ok {
		return errors.New("sandbox is not registered")
	}
	record.LastActivityAt = now.UTC()
	m.registry.Records[sandboxID] = record
	return m.persistLocked()
}

func (m *Manager) Reap(ctx context.Context, now time.Time) ([]string, error) {
	m.mu.Lock()
	candidates := make([]Record, 0)
	for _, record := range m.registry.Records {
		if record.StoppedAt == nil && record.ActiveCalls == 0 && record.BackgroundProcesses == 0 && now.Sub(record.LastActivityAt) >= m.Idle {
			candidates = append(candidates, record)
		}
	}
	m.mu.Unlock()
	stopped := make([]string, 0, len(candidates))
	for _, record := range candidates {
		unlock := m.lockEnsure(record.SandboxID)
		m.mu.Lock()
		current, exists := m.registry.Records[record.SandboxID]
		eligible := exists && current.StoppedAt == nil && current.ActiveCalls == 0 && current.BackgroundProcesses == 0 && now.Sub(current.LastActivityAt) >= m.Idle
		m.mu.Unlock()
		if !eligible {
			unlock()
			continue
		}
		if err := m.Engine.StopSandbox(ctx, record.ContainerName); err != nil {
			unlock()
			return stopped, err
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

func (m *Manager) Spec(sandboxID string) (driver.SandboxSpec, error) {
	m.mu.Lock()
	record, ok := m.registry.Records[sandboxID]
	m.mu.Unlock()
	if !ok {
		return driver.SandboxSpec{}, errors.New("sandbox is not registered")
	}
	return m.specForRecord(record)
}

func (m *Manager) ResolvePath(target, sandboxID, value string) (string, error) {
	spec, err := m.Spec(sandboxID)
	if err != nil {
		return "", err
	}
	if target == "host" {
		clean := filepath.Clean(value)
		for containerPath, hostPath := range map[string]string{contract.ContainerWorkspace: spec.Workspace, contract.ContainerAgentHome: spec.Home, contract.ContainerAgentEnv: spec.Environment} {
			if clean == containerPath {
				return hostPath, nil
			}
			if strings.HasPrefix(clean, containerPath+"/") {
				return containedJoin(hostPath, strings.TrimPrefix(clean, containerPath+"/"))
			}
		}
		if filepath.IsAbs(value) {
			return clean, nil
		}
		return containedJoin(spec.Workspace, value)
	}
	if target != "sandbox" {
		return "", errors.New("invalid execution target")
	}
	clean := filepath.Clean(value)
	if !filepath.IsAbs(clean) {
		return containedJoin(spec.Workspace, clean)
	}
	for containerPath, hostPath := range map[string]string{contract.ContainerWorkspace: spec.Workspace, contract.ContainerAgentHome: spec.Home, contract.ContainerAgentEnv: spec.Environment} {
		if clean == containerPath {
			return hostPath, nil
		}
		if strings.HasPrefix(clean, containerPath+"/") {
			return containedJoin(hostPath, strings.TrimPrefix(clean, containerPath+"/"))
		}
	}
	return "", errors.New("sandbox file tools can access only persistent mounted paths")
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

// ReconcileProcesses replaces volatile call/process counters with facts rebuilt
// from the persisted managed-process records after a Manager restart. Unknown
// or uninspectable sandbox processes are counted conservatively by the caller.
func (m *Manager) ReconcileProcesses(background map[string]int, now time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, record := range m.registry.Records {
		record.ActiveCalls = 0
		record.BackgroundProcesses = background[id]
		if record.BackgroundProcesses > 0 {
			record.StoppedAt = nil
			record.LastActivityAt = now.UTC()
		}
		m.registry.Records[id] = record
	}
	return m.persistLocked()
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
	for key, record := range m.registry.Records {
		if key == "" || record.SandboxID != key {
			return fmt.Errorf("sandbox registry key %q does not match record identity %q", key, record.SandboxID)
		}
		hash := stableHash(key)
		if record.SandboxHash != hash {
			return fmt.Errorf("sandbox registry %q has an invalid identity hash", key)
		}
		if record.ContainerName != "ubitech-sandbox-"+hash[:16] {
			return fmt.Errorf("sandbox registry %q has an invalid container name", key)
		}
		if _, err := m.workspacePath(record.WorkspaceID); err != nil {
			return fmt.Errorf("sandbox registry %q has an invalid workspace binding: %w", key, err)
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
	workspace, err := m.workspacePath(record.WorkspaceID)
	if err != nil {
		return driver.SandboxSpec{}, err
	}
	envRoot := filepath.Join(m.DataDir, "agent-envs", record.SandboxHash)
	spec := driver.SandboxSpec{ContainerName: record.ContainerName, AgentHash: record.SandboxHash, Image: record.Image, Network: m.Network, Workspace: workspace, Home: filepath.Join(envRoot, "home"), Environment: filepath.Join(envRoot, "env"), UID: m.UID, GID: m.GID}
	if path, ok := m.attachmentPath(record.WorkspaceID); ok {
		spec.Attachments = path
	}
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
	clean := filepath.ToSlash(filepath.Clean(workspaceID))
	if strings.HasPrefix(clean, "user-") {
		id := strings.TrimPrefix(clean, "user-")
		if id != "" && safeSegment(id) {
			return filepath.Join(m.DataDir, "attachments", "private", id), true
		}
	}
	if strings.HasPrefix(clean, "channels/channel-") {
		id := strings.TrimPrefix(clean, "channels/channel-")
		if id != "" && safeSegment(id) {
			return filepath.Join(m.DataDir, "attachments", "channel", id), true
		}
	}
	if strings.HasPrefix(clean, "channel-") {
		id := strings.TrimPrefix(clean, "channel-")
		if id != "" && safeSegment(id) {
			return filepath.Join(m.DataDir, "attachments", "channel", id), true
		}
	}
	return "", false
}
func safeSegment(value string) bool {
	for _, r := range value {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r == '_' || r == '-') {
			return false
		}
	}
	return value != ""
}
func (m *Manager) persistLocked() error { return atomicfile.WriteJSON(m.StatePath, m.registry, 0o600) }
func stableHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
func containedJoin(root, relative string) (string, error) {
	clean := filepath.Clean(relative)
	if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errors.New("path escapes workspace")
	}
	joined := filepath.Join(root, clean)
	rel, err := filepath.Rel(root, joined)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("path escapes workspace")
	}
	return joined, nil
}
