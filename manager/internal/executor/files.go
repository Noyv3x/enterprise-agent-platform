package executor

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/atomicfile"
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
			sandboxPath, pathErr := s.sandboxPath(call, args.Path)
			if pathErr != nil {
				return "", nil, pathErr
			}
			file, err = openSandboxRegular(sandboxPath)
		} else {
			path, pathErr := s.path(call, args.Path)
			if pathErr != nil {
				return "", nil, pathErr
			}
			file, err = openRegular(path)
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
			if err := writeSandboxFile(path, []byte(args.Content), 0o600); err != nil {
				return "", nil, err
			}
		} else {
			path, err := s.path(call, args.Path)
			if err != nil {
				return "", nil, err
			}
			if err := rejectSymlinkTarget(path); err != nil {
				return "", nil, err
			}
			if err := atomicfile.WriteFile(path, []byte(args.Content), 0o600); err != nil {
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
		var (
			sandboxPath sandboxFilePath
			path        string
			file        *os.File
			err         error
		)
		if call.Target == "sandbox" {
			sandboxPath, err = s.sandboxPath(call, args.Path)
			if err == nil {
				err = sandboxPath.rejectMutation()
			}
			if err == nil {
				file, err = openSandboxRegular(sandboxPath)
			}
		} else {
			path, err = s.path(call, args.Path)
			if err == nil {
				file, err = openRegular(path)
			}
		}
		if err != nil {
			return "", nil, err
		}
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
		if call.Target == "sandbox" {
			if err := writeSandboxFile(sandboxPath, updated, 0o600); err != nil {
				return "", nil, err
			}
		} else {
			if err := atomicfile.WriteFile(path, updated, 0o600); err != nil {
				return "", nil, err
			}
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
			results, err = searchSandbox(ctx, path, matcher, max)
			if err != nil {
				return "", nil, err
			}
		} else {
			root, pathErr := s.path(call, args.Path)
			if pathErr != nil {
				return "", nil, pathErr
			}
			err = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
				if walkErr != nil {
					return walkErr
				}
				select {
				case <-ctx.Done():
					return ctx.Err()
				default:
				}
				if len(results) >= max {
					return filepath.SkipAll
				}
				rel, _ := filepath.Rel(root, path)
				if matcher.MatchString(rel) {
					results = append(results, rel+": filename match")
				}
				if entry.Type()&os.ModeSymlink != 0 {
					return nil
				}
				if !entry.Type().IsRegular() {
					return nil
				}
				info, err := entry.Info()
				if err != nil {
					return err
				}
				if info.Size() > 2<<20 {
					return nil
				}
				file, err := openRegular(path)
				if err != nil {
					return err
				}
				scanner := bufio.NewScanner(file)
				scanner.Buffer(make([]byte, 64*1024), 2<<20)
				line := 0
				for scanner.Scan() && len(results) < max {
					line++
					text := scanner.Text()
					if matcher.MatchString(text) {
						if len(text) > 500 {
							text = text[:500]
						}
						results = append(results, fmt.Sprintf("%s:%d:%s", rel, line, text))
					}
				}
				closeErr := file.Close()
				if err := scanner.Err(); err != nil {
					return err
				}
				return closeErr
			})
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

func (s FileService) path(call Call, value string) (string, error) {
	if value == "" {
		return "", errors.New("path is required")
	}
	return s.Sandboxes.ResolvePath(call.Target, call.ExecutionContext.SandboxID, value)
}
func openRegular(path string) (*os.File, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("path is not a regular file")
	}
	return os.Open(path)
}
func rejectSymlinkTarget(path string) error {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return errors.New("refusing to replace a symbolic link")
	}
	if info.IsDir() {
		return errors.New("path is a directory")
	}
	return nil
}
func plural(count int) string {
	if count == 1 {
		return ""
	}
	return "s"
}
