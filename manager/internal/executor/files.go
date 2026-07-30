package executor

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/sandbox"
)

type FileService struct {
	Sandboxes *sandbox.Manager
	MaxBytes  int64
}

func (s FileService) Execute(ctx context.Context, call Call) (string, map[string]any, error) {
	if s.MaxBytes <= 0 {
		s.MaxBytes = 10 << 20
	}
	if _, err := s.Sandboxes.Ensure(ctx, call.ExecutionContext.SandboxID, call.ExecutionContext.WorkspaceID, time.Now()); err != nil {
		return "", nil, err
	}
	switch call.Action {
	case "read":
		var args fileReadArguments
		if err := decodeArguments(call.Arguments, &args); err != nil {
			return "", nil, err
		}
		if args.Offset < 0 {
			return "", nil, errors.New("offset must not be negative")
		}
		limit := args.Limit
		if limit == 0 {
			limit = 100000
		}
		if limit < 1 || limit > 1000000 {
			return "", nil, errors.New("limit is out of range")
		}
		var (
			file *os.File
			err  error
		)
		if call.Target == "sandbox" {
			path, pathErr := s.sandboxPath(call, args.Path)
			if pathErr != nil {
				return "", nil, pathErr
			}
			file, err = openManagedRegular(path)
		} else {
			path, pathErr := s.hostPath(call, args.Path, sandbox.HostPathRead)
			if pathErr != nil {
				return "", nil, pathErr
			}
			file, err = openManagedRegular(path)
		}
		if err != nil {
			return "", nil, err
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil {
			return "", nil, err
		}
		if args.Offset > info.Size() {
			args.Offset = info.Size()
		}
		if _, err := file.Seek(args.Offset, io.SeekStart); err != nil {
			return "", nil, err
		}
		data, err := io.ReadAll(io.LimitReader(file, limit))
		if err != nil {
			return "", nil, err
		}
		return string(data), map[string]any{"path": args.Path, "offset": args.Offset, "returned": len(data), "total": info.Size()}, nil
	case "write":
		var args fileWriteArguments
		if err := decodeArguments(call.Arguments, &args); err != nil {
			return "", nil, err
		}
		if int64(len(args.Content)) > s.MaxBytes {
			return "", nil, errors.New("file content exceeds manager limit")
		}
		if call.Target == "sandbox" {
			path, err := s.sandboxPath(call, args.Path)
			if err != nil {
				return "", nil, err
			}
			if err := writeManagedFile(path, []byte(args.Content), 0o600); err != nil {
				return "", nil, err
			}
		} else {
			path, err := s.hostPath(call, args.Path, sandbox.HostPathWrite)
			if err != nil {
				return "", nil, err
			}
			if err := writeManagedFile(path, []byte(args.Content), 0o600); err != nil {
				return "", nil, err
			}
		}
		return fmt.Sprintf("Wrote %d bytes to %s", len(args.Content), args.Path), map[string]any{"path": args.Path, "bytes": len(args.Content)}, nil
	case "patch":
		var args filePatchArguments
		if err := decodeArguments(call.Arguments, &args); err != nil {
			return "", nil, err
		}
		if args.OldText == "" {
			return "", nil, errors.New("old_text is required")
		}
		expected := args.ExpectedReplacements
		if expected == 0 {
			expected = 1
		}
		var path managedFilePath
		var err error
		if call.Target == "sandbox" {
			path, err = s.sandboxPath(call, args.Path)
		} else {
			path, err = s.hostPath(call, args.Path, sandbox.HostPathWrite)
		}
		if err == nil {
			err = path.rejectMutation()
		}
		if err != nil {
			return "", nil, err
		}
		file, parent, leaf, err := openManagedRegularForUpdate(path)
		if err != nil {
			return "", nil, err
		}
		defer parent.Close()
		data, err := io.ReadAll(io.LimitReader(file, s.MaxBytes+1))
		_ = file.Close()
		if err != nil {
			return "", nil, err
		}
		if int64(len(data)) > s.MaxBytes {
			return "", nil, errors.New("file exceeds patch size limit")
		}
		count := bytes.Count(data, []byte(args.OldText))
		if count != expected {
			return "", nil, fmt.Errorf("expected %d replacements, found %d", expected, count)
		}
		updated := bytes.ReplaceAll(data, []byte(args.OldText), []byte(args.NewText))
		if int64(len(updated)) > s.MaxBytes {
			return "", nil, errors.New("patched file exceeds manager limit")
		}
		if err := writeManagedFileAt(parent, leaf, updated, 0o600); err != nil {
			return "", nil, err
		}
		return fmt.Sprintf("Patched %s (%d replacement%s)", args.Path, count, plural(count)), map[string]any{"path": args.Path, "replacements": count}, nil
	case "search":
		var args fileSearchArguments
		if err := decodeArguments(call.Arguments, &args); err != nil {
			return "", nil, err
		}
		if args.Query == "" {
			return "", nil, errors.New("query is required")
		}
		if args.Path == "" {
			args.Path = "."
		}
		max := args.MaxResults
		if max == 0 {
			max = 100
		}
		if max < 1 || max > 1000 {
			return "", nil, errors.New("max_results is out of range")
		}
		pattern := regexp.QuoteMeta(args.Query)
		if args.Regex {
			pattern = args.Query
		}
		if !args.CaseSensitive {
			pattern = "(?i)" + pattern
		}
		matcher, err := regexp.Compile(pattern)
		if err != nil {
			return "", nil, fmt.Errorf("invalid search expression: %w", err)
		}
		results := make([]string, 0, max)
		if call.Target == "sandbox" {
			path, pathErr := s.sandboxPath(call, args.Path)
			if pathErr != nil {
				return "", nil, pathErr
			}
			results, err = searchManaged(ctx, path, matcher, max)
			if err != nil {
				return "", nil, err
			}
		} else {
			path, pathErr := s.hostPath(call, args.Path, sandbox.HostPathRead)
			if pathErr != nil {
				return "", nil, pathErr
			}
			results, err = searchManaged(ctx, path, matcher, max)
			if err != nil {
				return "", nil, err
			}
		}
		content := "No matches"
		if len(results) > 0 {
			content = strings.Join(results, "\n")
		}
		return content, map[string]any{"count": len(results)}, nil
	default:
		return "", nil, errors.New("unsupported file action")
	}
}
func plural(count int) string {
	if count == 1 {
		return ""
	}
	return "s"
}
