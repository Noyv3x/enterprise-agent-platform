package sandbox

import (
	"errors"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

// HostPathAccess selects the hard-block policy applied at the Manager's
// trusted host-path mapping boundary.
type HostPathAccess uint8

const (
	HostPathRead HostPathAccess = iota + 1
	HostPathWrite
	HostPathWorkingDirectory
)

// HostPath keeps the trusted filesystem root separate from the untrusted
// relative path. Executor code must walk from Root with O_NOFOLLOW instead of
// resolving Canonical again as a pathname.
type HostPath struct {
	Root      string
	Relative  string
	Canonical string

	access    HostPathAccess
	stateRoot string
}

// Allows reports whether a descendant reached while walking this path remains
// inside the approved tree and outside Manager/runtime protected paths. It is
// primarily used to omit protected subtrees from broad host searches.
func (p HostPath) Allows(candidate string) bool {
	clean := filepath.Clean(candidate)
	if !isAtOrBelow(clean, p.Canonical) {
		return false
	}
	return hostPathAllowed(p.access, clean, p.stateRoot)
}

// ResolveHostPath performs the only supported logical-to-host mapping. The
// returned path has not been opened yet; callers must use the fd-rooted helpers
// in executor so validation and use cannot be separated by string resolution.
func (m *Manager) ResolveHostPath(sandboxID, value string, access HostPathAccess) (HostPath, error) {
	if value == "" || strings.IndexByte(value, 0) >= 0 {
		return HostPath{}, errors.New("path is required")
	}
	if access != HostPathRead && access != HostPathWrite && access != HostPathWorkingDirectory {
		return HostPath{}, errors.New("invalid host path access")
	}
	spec, err := m.Spec(sandboxID)
	if err != nil {
		return HostPath{}, err
	}

	clean := filepath.Clean(value)
	root, relative := spec.Workspace, clean
	if filepath.IsAbs(clean) {
		type mapping struct {
			logical string
			host    string
		}
		mappings := []mapping{
			{logical: contract.ContainerWorkspace, host: spec.Workspace},
			{logical: contract.ContainerAgentHome, host: spec.Home},
			{logical: contract.ContainerAgentEnv, host: spec.Environment},
		}
		mapped := false
		for _, candidate := range mappings {
			if child, ok := relativeHostPath(candidate.logical, clean); ok {
				root, relative, mapped = candidate.host, child, true
				break
			}
		}
		if !mapped {
			root = string(filepath.Separator)
			relative = strings.TrimPrefix(clean, string(filepath.Separator))
			if relative == "" {
				relative = "."
			}
		}
	} else if _, err := cleanHostRelative(relative); err != nil {
		return HostPath{}, err
	}

	relative, err = cleanHostRelative(relative)
	if err != nil {
		return HostPath{}, err
	}
	canonical := filepath.Clean(root)
	if relative != "." {
		canonical = filepath.Join(canonical, relative)
	}
	stateRoot := filepath.Clean(filepath.Dir(m.StatePath))
	if !hostPathAllowed(access, canonical, stateRoot) {
		return HostPath{}, errors.New("host path is protected by the Manager")
	}
	return HostPath{Root: filepath.Clean(root), Relative: relative, Canonical: canonical, access: access, stateRoot: stateRoot}, nil
}

func relativeHostPath(root, path string) (string, bool) {
	if path == root {
		return ".", true
	}
	if !strings.HasPrefix(path, root+string(filepath.Separator)) {
		return "", false
	}
	child, err := cleanHostRelative(strings.TrimPrefix(path, root+string(filepath.Separator)))
	return child, err == nil
}

func cleanHostRelative(value string) (string, error) {
	clean := filepath.Clean(value)
	if clean == "." {
		return clean, nil
	}
	if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errors.New("host path escapes its trusted root")
	}
	for _, part := range strings.Split(clean, string(filepath.Separator)) {
		if part == "" || part == "." || part == ".." || strings.IndexByte(part, 0) >= 0 {
			return "", errors.New("host path contains an invalid component")
		}
	}
	return clean, nil
}

func hostPathAllowed(access HostPathAccess, path, stateRoot string) bool {
	if protectedManagerHostPath(path, stateRoot) || isDockerSocket(path) {
		return false
	}
	switch access {
	case HostPathRead:
		return !protectedHostReadPath(path)
	case HostPathWrite:
		return !protectedHostWritePath(path)
	case HostPathWorkingDirectory:
		return true
	default:
		return false
	}
}

func protectedManagerHostPath(path, stateRoot string) bool {
	clean := filepath.Clean(path)
	if filepath.IsAbs(stateRoot) && isAtOrBelow(clean, stateRoot) {
		return true
	}
	profile := identity.SourceProfile()
	for _, root := range []string{
		filepath.Join("/run", profile.DataDirectory),
		filepath.Join("/var/run", profile.DataDirectory),
		filepath.Join(profile.ContainerDataRoot, profile.ManagerStateDirectory),
	} {
		if isAtOrBelow(clean, root) {
			return true
		}
	}
	parts := strings.Split(strings.TrimPrefix(filepath.ToSlash(clean), "/"), "/")
	homeOffset := -1
	if len(parts) >= 1 && parts[0] == "root" {
		homeOffset = 1
	} else if len(parts) >= 2 && parts[0] == "home" && parts[1] != "" {
		homeOffset = 2
	}
	if homeOffset >= 0 {
		rest := parts[homeOffset:]
		if hasPathPrefix(rest, []string{".config", profile.ConfigDirectory}) ||
			hasPathPrefix(rest, []string{".local", "share", profile.DataDirectory, profile.ManagerStateDirectory}) {
			return true
		}
	}
	return false
}

func protectedHostReadPath(path string) bool {
	parts := strings.Split(strings.TrimPrefix(filepath.ToSlash(filepath.Clean(path)), "/"), "/")
	if len(parts) < 2 || parts[0] != "proc" {
		return false
	}
	if len(parts) == 2 && (parts[1] == "kcore" || parts[1] == "keys" || parts[1] == "key-users") {
		return true
	}
	if len(parts) < 3 || !(parts[1] == "self" || parts[1] == "thread-self" || decimalPathPart(parts[1])) {
		return false
	}
	return parts[2] == "environ" || parts[2] == "cmdline" || parts[2] == "mem" || parts[2] == "fd"
}

func protectedHostWritePath(path string) bool {
	clean := filepath.Clean(path)
	if clean == "/dev/null" || clean == "/dev/stdin" || clean == "/dev/stdout" || clean == "/dev/stderr" {
		return false
	}
	for _, root := range []string{"/etc", "/boot", "/proc", "/sys", "/dev"} {
		if isAtOrBelow(clean, root) {
			return true
		}
	}
	return false
}

func isDockerSocket(path string) bool {
	clean := filepath.Clean(path)
	return clean == "/run/docker.sock" || clean == "/var/run/docker.sock"
}

func isAtOrBelow(path, root string) bool {
	path, root = filepath.Clean(path), filepath.Clean(root)
	if path == root {
		return true
	}
	if root == string(filepath.Separator) {
		return filepath.IsAbs(path)
	}
	return strings.HasPrefix(path, root+string(filepath.Separator))
}

func hasPathPrefix(value, prefix []string) bool {
	if len(value) < len(prefix) {
		return false
	}
	for index := range prefix {
		if value[index] != prefix[index] {
			return false
		}
	}
	return true
}

func decimalPathPart(value string) bool {
	if value == "" {
		return false
	}
	for _, character := range value {
		if !unicode.IsDigit(character) || character > unicode.MaxASCII {
			return false
		}
	}
	return true
}
