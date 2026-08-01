package handofftransform

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
)

// Validators combines independently reviewable invariants. An empty set is
// rejected so a Structured resource cannot accidentally receive a no-op
// validation policy through this helper.
func Validators(validators ...Validator) Validator {
	return ValidateFunc(func(ctx context.Context, input ValidationInput) error {
		if len(validators) == 0 {
			return errors.New("at least one structured validator is required")
		}
		for index, validator := range validators {
			if validator == nil {
				return fmt.Errorf("structured validator %d is nil", index)
			}
			if err := validator.Validate(ctx, input); err != nil {
				return fmt.Errorf("structured validator %d: %w", index, err)
			}
		}
		return nil
	})
}

// PreserveExactSubtrees proves that selected relative paths and every child
// retain their type, mode, size, mtime, and bytes across a structured
// transformation. It is intended for user files, transcripts, attachment
// payloads, and third-party browser storage. Paths must be explicit products
// of a versioned reader; "." would make all machine-owned fields immutable and
// is therefore rejected here.
func PreserveExactSubtrees(paths ...string) (Validator, error) {
	if len(paths) == 0 {
		return nil, errors.New("at least one exact subtree is required")
	}
	cleaned := append([]string(nil), paths...)
	sort.Strings(cleaned)
	for index, path := range cleaned {
		if path == "." || validateRelative(path) != nil {
			return nil, fmt.Errorf("invalid exact subtree %q", path)
		}
		if index > 0 && (path == cleaned[index-1] || strings.HasPrefix(path, cleaned[index-1]+"/")) {
			return nil, fmt.Errorf("exact subtree %q overlaps %q", path, cleaned[index-1])
		}
	}
	return ValidateFunc(func(_ context.Context, input ValidationInput) error {
		source := entriesByPath(input.SourceEntries)
		target := entriesByPath(input.TargetEntries)
		for _, root := range cleaned {
			matched := false
			for path, sourceEntry := range source {
				if path != root && !strings.HasPrefix(path, root+"/") {
					continue
				}
				matched = true
				targetEntry, exists := target[path]
				if !exists {
					return fmt.Errorf("preserved subtree entry %s is missing from target", path)
				}
				if !contentInvariantEqual(sourceEntry, targetEntry) {
					return fmt.Errorf("preserved subtree entry %s changed", path)
				}
			}
			if !matched {
				return fmt.Errorf("preserved subtree %s is absent from source", root)
			}
			for path := range target {
				if path != root && !strings.HasPrefix(path, root+"/") {
					continue
				}
				if _, exists := source[path]; !exists {
					return fmt.Errorf("preserved subtree has unexpected target entry %s", path)
				}
			}
		}
		return nil
	}), nil
}

func entriesByPath(entries []Entry) map[string]Entry {
	out := make(map[string]Entry, len(entries))
	for _, entry := range entries {
		out[entry.Path] = entry
	}
	return out
}

func contentInvariantEqual(source, target Entry) bool {
	return source.Path == target.Path && source.Type == target.Type && source.Mode == target.Mode &&
		source.Size == target.Size && source.ModifiedNanos == target.ModifiedNanos && source.SHA256 == target.SHA256
}
