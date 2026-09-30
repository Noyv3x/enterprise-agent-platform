package executor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	technicalidentity "github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/sandbox"
)

type FileService struct {
	Sandboxes *sandbox.Manager
	MaxBytes  int64
	profile   technicalidentity.Profile
}

func NewFileService(active technicalidentity.ActiveProfile, sandboxes *sandbox.Manager, maxBytes int64) (FileService, error) {
	profile, err := active.Profile()
	if err != nil {
		return FileService{}, fmt.Errorf("file executor technical profile: %w", err)
	}
	return FileService{Sandboxes: sandboxes, MaxBytes: maxBytes, profile: profile}, nil
}

func (s FileService) Execute(ctx context.Context, call Call) (string, map[string]any, error) {
	if call.Target != "sandbox" {
		return "", nil, errors.New("target must be sandbox")
	}
	if s.MaxBytes <= 0 {
		s.MaxBytes = 10 << 20
	}
	if _, err := s.Sandboxes.Ensure(ctx, call.ExecutionContext.SandboxID, call.ExecutionContext.WorkspaceID, time.Now(), call.ExecutionContext.Profile); err != nil {
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
		path, err := s.sandboxPath(call, args.Path)
		if err != nil {
			return "", nil, err
		}
		file, err := openManagedRegular(path)
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
		path, err := s.sandboxPath(call, args.Path)
		if err != nil {
			return "", nil, err
		}
		if err := writeManagedFile(path, []byte(args.Content), 0o600, s.profile.InternalWorkspaceDirectory); err != nil {
			return "", nil, err
		}
		return fmt.Sprintf("Wrote %d bytes to %s", len(args.Content), args.Path), map[string]any{"path": args.Path, "bytes": len(args.Content)}, nil
	default:
		return "", nil, errors.New("unsupported file action")
	}
}
