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
)

const (
	sandboxRegistrySchemaVersion = 2
	maxSandboxRegistryBytes      = 8 << 20
)

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

func (m *Manager) loadRegistry() error {
	data, err := readSandboxRegistry(m.StatePath, m.UID, m.GID)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := rejectDuplicateJSONKeys(data); err != nil {
		return fmt.Errorf("decode sandbox registry: %w", err)
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(data, &envelope); err != nil {
		return fmt.Errorf("decode sandbox registry: %w", err)
	}
	versionJSON, ok := envelope["schema_version"]
	if !ok {
		return errors.New("decode sandbox registry: schema_version is required")
	}
	var version int
	if err := json.Unmarshal(versionJSON, &version); err != nil {
		return fmt.Errorf("decode sandbox registry schema_version: %w", err)
	}
	if version != sandboxRegistrySchemaVersion {
		return fmt.Errorf("unsupported sandbox registry schema %d", version)
	}
	var current registry
	if err := decodeSandboxRegistryStrict(data, &current); err != nil {
		return err
	}
	m.registry = current
	return nil
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
