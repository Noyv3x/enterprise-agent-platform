//go:build linux

package main

import (
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
)

type startupArgumentShape uint8

const (
	startupArgumentValue startupArgumentShape = iota
	startupArgumentBool
)

type startupArgumentSpec struct {
	options       map[string]startupArgumentShape
	requireConfig bool
	required      []string
}

type startupArguments struct {
	ConfigPath string
	PlanPath   string
}

var startupCommandArguments = map[string]startupArgumentSpec{
	"serve":                       {options: startupOptions("config", startupArgumentValue)},
	"preflight":                   {options: startupOptions("config", startupArgumentValue, "probe-user-systemd-transient", startupArgumentBool)},
	"install":                     {options: startupOptions("config", startupArgumentValue, "release-manifest-url", startupArgumentValue)},
	"status":                      {options: startupOptions("config", startupArgumentValue)},
	"check":                       {options: startupOptions("config", startupArgumentValue, "release-manifest-url", startupArgumentValue)},
	"update":                      {options: startupOptions("config", startupArgumentValue, "release-manifest-url", startupArgumentValue)},
	"restart":                     {options: startupOptions("config", startupArgumentValue, "release-manifest-url", startupArgumentValue)},
	"rollback":                    {options: startupOptions("config", startupArgumentValue, "release-manifest-url", startupArgumentValue)},
	"repair":                      {options: startupOptions("config", startupArgumentValue, "release-manifest-url", startupArgumentValue)},
	"logs":                        {options: startupOptions("config", startupArgumentValue, "service", startupArgumentValue, "tail", startupArgumentValue)},
	"recover-current":             {options: startupOptions("config", startupArgumentValue, "expected-sha256", startupArgumentValue, "yes", startupArgumentBool), requireConfig: true, required: []string{"expected-sha256", "yes"}},
	"self-update-watchdog":        {options: startupOptions("config", startupArgumentValue, "plan", startupArgumentValue), required: []string{"plan"}},
	"release-transition identity": {options: startupOptions("config", startupArgumentValue, "public-key-pem", startupArgumentValue)},
	"release-transition attest":   {options: startupOptions("config", startupArgumentValue, "challenge", startupArgumentValue, "receipt", startupArgumentValue, "signature", startupArgumentValue)},
}

func startupOptions(values ...any) map[string]startupArgumentShape {
	result := make(map[string]startupArgumentShape, len(values)/2)
	for index := 0; index < len(values); index += 2 {
		result[values[index].(string)] = values[index+1].(startupArgumentShape)
	}
	return result
}

// parseStartupArguments is deliberately smaller and stricter than flag.Parse.
// It runs before startup routing and accepts only the statically registered
// command shape.  The result can locate a source baseline, but cannot carry a
// profile name or any other target-selection input.
func parseStartupArguments(command string, arguments []string) (startupArguments, error) {
	key := command
	options := arguments
	if command == "release-transition" {
		if len(arguments) == 0 || (arguments[0] != "identity" && arguments[0] != "attest") {
			return startupArguments{}, errors.New("release-transition requires a known static subcommand")
		}
		key += " " + arguments[0]
		options = arguments[1:]
	}
	spec, ok := startupCommandArguments[key]
	if !ok {
		return startupArguments{}, fmt.Errorf("command %q has no startup argument contract", key)
	}
	seen := make(map[string]struct{}, len(options))
	values := make(map[string]string, len(options))
	booleans := make(map[string]bool, len(options))
	for index := 0; index < len(options); index++ {
		raw := options[index]
		if raw == "" || raw == "-" || raw == "--" || !strings.HasPrefix(raw, "-") {
			return startupArguments{}, fmt.Errorf("%s accepts no positional or option-terminator arguments", key)
		}
		nameValue := strings.TrimPrefix(raw, "-")
		nameValue = strings.TrimPrefix(nameValue, "-")
		name, value, assigned := strings.Cut(nameValue, "=")
		shape, allowed := spec.options[name]
		if !allowed {
			return startupArguments{}, fmt.Errorf("unknown %s option %q", key, raw)
		}
		if _, duplicate := seen[name]; duplicate {
			return startupArguments{}, fmt.Errorf("%s option --%s was supplied more than once", key, name)
		}
		seen[name] = struct{}{}
		switch shape {
		case startupArgumentBool:
			if assigned {
				parsed, err := strconv.ParseBool(value)
				if err != nil {
					return startupArguments{}, fmt.Errorf("%s option --%s has an invalid boolean value", key, name)
				}
				booleans[name] = parsed
			} else {
				booleans[name] = true
			}
		case startupArgumentValue:
			if !assigned {
				index++
				if index >= len(options) {
					return startupArguments{}, fmt.Errorf("%s option --%s is missing its value", key, name)
				}
				value = options[index]
			}
			if value == "" {
				return startupArguments{}, fmt.Errorf("%s option --%s has an empty value", key, name)
			}
			values[name] = value
		default:
			return startupArguments{}, errors.New("invalid startup argument contract")
		}
	}
	result := startupArguments{ConfigPath: values["config"], PlanPath: values["plan"]}
	if spec.requireConfig && result.ConfigPath == "" {
		return startupArguments{}, fmt.Errorf("%s requires an explicit --config path", key)
	}
	for _, name := range spec.required {
		if _, found := seen[name]; !found {
			return startupArguments{}, fmt.Errorf("%s requires --%s", key, name)
		}
		if shape := spec.options[name]; shape == startupArgumentBool && !booleans[name] {
			return startupArguments{}, fmt.Errorf("%s requires --%s=true", key, name)
		}
	}
	for label, path := range map[string]string{"config": result.ConfigPath, "plan": result.PlanPath} {
		if path != "" && (!filepath.IsAbs(path) || filepath.Clean(path) != path || strings.ContainsRune(path, 0)) {
			return startupArguments{}, fmt.Errorf("%s path must be canonical and absolute", label)
		}
	}
	return result, nil
}
