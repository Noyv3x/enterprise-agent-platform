//go:build linux

package sandbox

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	pathpkg "path"
	"path/filepath"
	"syscall"
	"time"
)

const (
	sandboxRegistrySchemaVersion = 2
	maxSandboxRegistryBytes      = 8 << 20
)

// registryV1 is the complete legacy shape. Keeping a separate type prevents a
// missing v2 field from being confused with its zero value during the one-time
// source-owner upgrade.
type registryV1 struct {
	SchemaVersion int                 `json:"schema_version"`
	Records       map[string]recordV1 `json:"records"`
}

type recordV1 struct {
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

type persistentBinding struct {
	UID             int
	GID             int
	WorkspacePath   string
	HomePath        string
	EnvironmentPath string
	AttachmentsPath string
}

func (b persistentBinding) relativePaths() []string {
	return []string{b.WorkspacePath, b.HomePath, b.EnvironmentPath, b.AttachmentsPath}
}

func bindingFromRecord(record Record) persistentBinding {
	return persistentBinding{
		UID:             record.UID,
		GID:             record.GID,
		WorkspacePath:   record.WorkspacePath,
		HomePath:        record.HomePath,
		EnvironmentPath: record.EnvironmentPath,
		AttachmentsPath: record.AttachmentsPath,
	}
}

func (m *Manager) loadRegistry() (bool, error) {
	data, err := readSandboxRegistry(m.StatePath, m.UID, m.GID)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := rejectDuplicateJSONKeys(data); err != nil {
		return false, fmt.Errorf("decode sandbox registry: %w", err)
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(data, &envelope); err != nil {
		return false, fmt.Errorf("decode sandbox registry: %w", err)
	}
	versionJSON, ok := envelope["schema_version"]
	if !ok {
		return false, errors.New("decode sandbox registry: schema_version is required")
	}
	var version int
	if err := json.Unmarshal(versionJSON, &version); err != nil {
		return false, fmt.Errorf("decode sandbox registry schema_version: %w", err)
	}
	switch version {
	case 1:
		var legacy registryV1
		if err := decodeSandboxRegistryStrict(data, &legacy); err != nil {
			return false, err
		}
		if legacy.Records == nil {
			return false, errors.New("sandbox registry v1 records must be an object")
		}
		upgraded := registry{
			SchemaVersion:    sandboxRegistrySchemaVersion,
			TechnicalProfile: m.profile.ProfileID,
			Records:          make(map[string]Record, len(legacy.Records)),
		}
		for key, old := range legacy.Records {
			record, err := m.upgradeV1Record(key, old)
			if err != nil {
				return false, err
			}
			upgraded.Records[key] = record
		}
		m.registry = upgraded
		return true, nil
	case sandboxRegistrySchemaVersion:
		var current registry
		if err := decodeSandboxRegistryStrict(data, &current); err != nil {
			return false, err
		}
		m.registry = current
		return false, nil
	default:
		return false, fmt.Errorf("unsupported sandbox registry schema %d", version)
	}
}

func (m *Manager) upgradeV1Record(key string, old recordV1) (Record, error) {
	if key == "" || old.SandboxID != key {
		return Record{}, fmt.Errorf("sandbox registry v1 key %q does not match record identity %q", key, old.SandboxID)
	}
	hash := stableHash(key)
	if old.SandboxHash != hash {
		return Record{}, fmt.Errorf("sandbox registry v1 %q has an invalid identity hash", key)
	}
	if old.ContainerName != m.profile.SandboxContainerPrefix+hash[:16] {
		return Record{}, fmt.Errorf("sandbox registry v1 %q has an invalid container name", key)
	}
	if old.Image == "" {
		return Record{}, fmt.Errorf("sandbox registry v1 %q has no image identity", key)
	}
	if old.ActiveCalls < 0 || old.BackgroundProcesses < 0 {
		return Record{}, fmt.Errorf("sandbox registry v1 %q has invalid activity counters", key)
	}
	binding, err := m.expectedBinding(old.WorkspaceID, hash)
	if err != nil {
		return Record{}, fmt.Errorf("sandbox registry v1 %q has an invalid persistent binding: %w", key, err)
	}
	for _, relative := range binding.relativePaths() {
		path, err := m.dataPath(relative)
		if err != nil {
			return Record{}, fmt.Errorf("sandbox registry v1 %q has an invalid path: %w", key, err)
		}
		if err := validateOwnedDirectoryBelow(m.DataDir, path, binding.UID, binding.GID); err != nil {
			return Record{}, fmt.Errorf("sandbox registry v1 %q cannot prove directory %q: %w", key, relative, err)
		}
	}
	return Record{
		SandboxID:           old.SandboxID,
		SandboxHash:         old.SandboxHash,
		WorkspaceID:         old.WorkspaceID,
		UID:                 binding.UID,
		GID:                 binding.GID,
		WorkspacePath:       binding.WorkspacePath,
		HomePath:            binding.HomePath,
		EnvironmentPath:     binding.EnvironmentPath,
		AttachmentsPath:     binding.AttachmentsPath,
		ContainerName:       old.ContainerName,
		Image:               old.Image,
		LastActivityAt:      old.LastActivityAt,
		ActiveCalls:         old.ActiveCalls,
		BackgroundProcesses: old.BackgroundProcesses,
		StoppedAt:           old.StoppedAt,
	}, nil
}

func (m *Manager) expectedBinding(workspaceID, sandboxHash string) (persistentBinding, error) {
	if sandboxHash == "" {
		return persistentBinding{}, errors.New("sandbox hash is required")
	}
	if _, err := m.workspacePath(workspaceID); err != nil {
		return persistentBinding{}, err
	}
	attachments, ok := attachmentRelativePath(workspaceID)
	if !ok {
		return persistentBinding{}, errors.New("workspace has no canonical attachment binding")
	}
	workspace := pathpkg.Join("workspaces", filepath.ToSlash(filepath.Clean(workspaceID)))
	envRoot := pathpkg.Join("agent-envs", sandboxHash)
	return persistentBinding{
		UID:             m.UID,
		GID:             m.GID,
		WorkspacePath:   workspace,
		HomePath:        pathpkg.Join(envRoot, "home"),
		EnvironmentPath: pathpkg.Join(envRoot, "env"),
		AttachmentsPath: attachments,
	}, nil
}

func (m *Manager) validateRecordBinding(record Record) error {
	expected, err := m.expectedBinding(record.WorkspaceID, record.SandboxHash)
	if err != nil {
		return fmt.Errorf("sandbox %q has an invalid persistent binding: %w", record.SandboxID, err)
	}
	if bindingFromRecord(record) != expected {
		return fmt.Errorf("sandbox %q persistent binding does not match the trusted data layout", record.SandboxID)
	}
	return nil
}

func (m *Manager) dataPath(relative string) (string, error) {
	if relative == "" || filepath.IsAbs(relative) || filepath.Clean(m.DataDir) != m.DataDir || !filepath.IsAbs(m.DataDir) {
		return "", errors.New("sandbox data root and persisted path must be canonical")
	}
	if filepath.Separator != '/' && filepath.ToSlash(relative) != relative {
		return "", errors.New("persisted sandbox path must use slash separators")
	}
	clean := pathpkg.Clean(relative)
	if clean != relative || clean == "." || clean == ".." || len(clean) > 4096 || pathpkg.IsAbs(clean) || clean[:1] == "/" {
		return "", errors.New("persisted sandbox path is not canonical")
	}
	for _, part := range bytes.Split([]byte(clean), []byte{'/'}) {
		if len(part) == 0 || bytes.Equal(part, []byte(".")) || bytes.Equal(part, []byte("..")) || bytes.IndexByte(part, 0) >= 0 {
			return "", errors.New("persisted sandbox path contains an invalid segment")
		}
	}
	target := filepath.Join(m.DataDir, filepath.FromSlash(clean))
	rel, err := filepath.Rel(m.DataDir, target)
	if err != nil || rel == "." || rel == ".." || filepath.IsAbs(rel) {
		return "", errors.New("persisted sandbox path escapes the data root")
	}
	return target, nil
}

func attachmentRelativePath(workspaceID string) (string, bool) {
	clean := filepath.ToSlash(filepath.Clean(workspaceID))
	if len(clean) > len("user-") && clean[:len("user-")] == "user-" {
		id := clean[len("user-"):]
		if safeSegment(id) {
			return pathpkg.Join("attachments", "private", id), true
		}
	}
	prefix := "channels/channel-"
	if len(clean) > len(prefix) && clean[:len(prefix)] == prefix {
		id := clean[len(prefix):]
		if safeSegment(id) {
			return pathpkg.Join("attachments", "channel", id), true
		}
	}
	prefix = "channel-"
	if len(clean) > len(prefix) && clean[:len(prefix)] == prefix {
		id := clean[len(prefix):]
		if safeSegment(id) {
			return pathpkg.Join("attachments", "channel", id), true
		}
	}
	return "", false
}

func readSandboxRegistry(path string, uid, gid int) ([]byte, error) {
	pathInfo, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if pathInfo.Mode()&os.ModeSymlink != 0 || !pathInfo.Mode().IsRegular() {
		return nil, errors.New("sandbox registry must be a regular non-symlink file")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	openedInfo, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("stat sandbox registry: %w", err)
	}
	if !os.SameFile(pathInfo, openedInfo) {
		return nil, errors.New("sandbox registry changed while opening")
	}
	stat, ok := openedInfo.Sys().(*syscall.Stat_t)
	if !ok || stat.Nlink != 1 || stat.Uid != uint32(uid) || stat.Gid != uint32(gid) {
		return nil, fmt.Errorf("sandbox registry must be singly linked and owned by %d:%d", uid, gid)
	}
	if openedInfo.Mode().Perm() != 0o600 {
		return nil, errors.New("sandbox registry must have mode 0600")
	}
	if openedInfo.Size() > maxSandboxRegistryBytes {
		return nil, fmt.Errorf("sandbox registry exceeds %d-byte limit", maxSandboxRegistryBytes)
	}
	data, err := io.ReadAll(io.LimitReader(file, maxSandboxRegistryBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read sandbox registry: %w", err)
	}
	if len(data) > maxSandboxRegistryBytes {
		return nil, fmt.Errorf("sandbox registry exceeds %d-byte limit", maxSandboxRegistryBytes)
	}
	return data, nil
}

func decodeSandboxRegistryStrict(data []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return fmt.Errorf("decode sandbox registry: %w", err)
	}
	if token, err := decoder.Token(); !errors.Is(err, io.EOF) {
		if err == nil {
			return fmt.Errorf("decode sandbox registry: trailing JSON token %v", token)
		}
		return fmt.Errorf("decode sandbox registry: %w", err)
	}
	return nil
}

func rejectDuplicateJSONKeys(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := consumeJSONValue(decoder); err != nil {
		return err
	}
	if token, err := decoder.Token(); !errors.Is(err, io.EOF) {
		if err == nil {
			return fmt.Errorf("trailing JSON token %v", token)
		}
		return err
	}
	return nil
}

func consumeJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		keys := map[string]struct{}{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("JSON object key is not a string")
			}
			if _, exists := keys[key]; exists {
				return fmt.Errorf("duplicate JSON key %q", key)
			}
			keys[key] = struct{}{}
			if err := consumeJSONValue(decoder); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim('}') {
			return errors.New("unterminated JSON object")
		}
	case '[':
		for decoder.More() {
			if err := consumeJSONValue(decoder); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim(']') {
			return errors.New("unterminated JSON array")
		}
	default:
		return errors.New("unexpected closing JSON delimiter")
	}
	return nil
}
