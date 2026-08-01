//go:build linux

package handoffsource

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoffhost"
)

// SystemdCLI uses bounded, non-shell systemctl calls. Runner exists only for
// deterministic tests; the default is handoffhost's bounded CommandRunner.
type SystemdCLI struct {
	Runner handoffhost.Runner
}

func (systemd SystemdCLI) runner() handoffhost.Runner {
	if systemd.Runner != nil {
		return systemd.Runner
	}
	return handoffhost.CommandRunner{}
}

func (systemd SystemdCLI) Show(ctx context.Context, unit string) (UnitState, error) {
	if !validServiceUnit(unit) {
		return UnitState{}, errors.New("systemd unit name is invalid")
	}
	output, err := systemd.runner().Run(ctx, "systemctl", "--user", "show", unit, "--no-pager",
		"--property=LoadState", "--property=ActiveState", "--property=UnitFileState", "--property=FragmentPath", "--property=MainPID")
	if err != nil {
		return UnitState{}, err
	}
	properties, err := parseProperties(output, []string{"LoadState", "ActiveState", "UnitFileState", "FragmentPath", "MainPID"})
	if err != nil {
		return UnitState{}, err
	}
	pid, err := strconv.Atoi(properties["MainPID"])
	if err != nil || pid < 0 {
		return UnitState{}, errors.New("systemd MainPID is invalid")
	}
	fragment := properties["FragmentPath"]
	if fragment != "" && (!canonicalAbsolute(fragment) || filepath.Base(fragment) != unit) {
		return UnitState{}, errors.New("systemd FragmentPath is invalid")
	}
	return UnitState{
		LoadState: properties["LoadState"], ActiveState: properties["ActiveState"],
		UnitFileState: properties["UnitFileState"], FragmentPath: fragment, MainPID: pid,
	}, nil
}

func (systemd SystemdCLI) ActiveUnits(ctx context.Context, prefixes []string) ([]string, error) {
	if len(prefixes) == 0 {
		return nil, errors.New("systemd active-unit prefixes are required")
	}
	for _, prefix := range prefixes {
		if prefix == "" || strings.ContainsAny(prefix, " \t\r\n/\\") {
			return nil, errors.New("systemd active-unit prefix is invalid")
		}
	}
	output, err := systemd.runner().Run(ctx, "systemctl", "--user", "list-units", "--type=service",
		"--state=active,activating,reloading,deactivating", "--all", "--plain", "--no-legend", "--no-pager")
	if err != nil {
		return nil, err
	}
	var matched []string
	seen := map[string]struct{}{}
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 4 || !validServiceUnit(fields[0]) {
			return nil, fmt.Errorf("systemd returned an invalid active-unit row %q", line)
		}
		for _, prefix := range prefixes {
			if strings.HasPrefix(fields[0], prefix) {
				if _, duplicate := seen[fields[0]]; duplicate {
					return nil, fmt.Errorf("systemd returned duplicate active unit %q", fields[0])
				}
				seen[fields[0]] = struct{}{}
				matched = append(matched, fields[0])
				break
			}
		}
	}
	sort.Strings(matched)
	return matched, nil
}

func parseProperties(data []byte, expected []string) (map[string]string, error) {
	allowed := make(map[string]struct{}, len(expected))
	for _, key := range expected {
		allowed[key] = struct{}{}
	}
	result := make(map[string]string, len(expected))
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if line == "" {
			continue
		}
		key, value, found := strings.Cut(line, "=")
		if !found {
			return nil, fmt.Errorf("invalid systemd property row %q", line)
		}
		if _, ok := allowed[key]; !ok {
			return nil, fmt.Errorf("unexpected systemd property %q", key)
		}
		if _, duplicate := result[key]; duplicate {
			return nil, fmt.Errorf("duplicate systemd property %q", key)
		}
		result[key] = value
	}
	for _, key := range expected {
		if _, ok := result[key]; !ok {
			return nil, fmt.Errorf("systemd property %q is missing", key)
		}
	}
	return result, nil
}

func validServiceUnit(unit string) bool {
	return unit != "" && strings.HasSuffix(unit, ".service") && filepath.Base(unit) == unit &&
		!strings.ContainsAny(unit, " \t\r\n\\")
}
