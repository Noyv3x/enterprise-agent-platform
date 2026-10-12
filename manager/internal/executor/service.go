package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

type Service struct {
	Audits    AuditStore
	Processes *ProcessManager
	// Background supervises processes that outlive their request and run.
	Background *BackgroundManager
	// MCP supervises local stdio MCP servers behind the lossless channel.
	MCP   *MCPManager
	Files FileService
}

func (s *Service) Audit(request AuditRequest) (AuditReceipt, error) {
	if request.Operation == "mcp" {
		details, err := projectMCPAudit(request.Action, request.Arguments)
		if err != nil {
			return AuditReceipt{}, err
		}
		request.Details = details
	}
	return s.Audits.Record(request)
}
func (s *Service) Terminal(ctx context.Context, call Call) (map[string]any, error) {
	return s.terminal(ctx, call, nil)
}
func (s *Service) terminal(ctx context.Context, call Call, live *liveOutput) (map[string]any, error) {
	if call.Action != "run" {
		return nil, errors.New("terminal action must be run")
	}
	var args terminalArguments
	if err := decodeArguments(call.Arguments, &args); err != nil {
		return nil, err
	}
	if err := validateTerminalArguments(args); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	record, err := s.Audits.Consume(call, "terminal")
	if err != nil {
		return nil, err
	}
	command, ok := record.Details["command"].(string)
	if !ok || command == "" {
		return nil, errors.New("terminal audit requires a safe command projection")
	}
	args.DisplayCommand = redactRetainedText(command)
	args.live = live
	if err := s.Audits.Started(call, map[string]any{"operation": record.Operation, "arguments": record.Details}); err != nil {
		return nil, err
	}
	result, runErr := s.Processes.Run(ctx, call, args)
	_ = s.Audits.Finished(call, processAuditSummary(result), runErr)
	if runErr != nil {
		return nil, runErr
	}
	return map[string]any{"result": result}, nil
}

func (s *Service) File(ctx context.Context, call Call) (map[string]any, error) {
	allowed := map[string]string{"read": "read_file", "write": "write_file"}
	operation := allowed[call.Action]
	if operation == "" {
		return nil, fmt.Errorf("unsupported file action %q", call.Action)
	}
	record, err := s.Audits.Consume(call, operation)
	if err != nil {
		return nil, err
	}
	if err := s.Audits.Started(call, map[string]any{"operation": record.Operation, "arguments": record.Details}); err != nil {
		return nil, err
	}
	content, details, fileErr := s.Files.Execute(ctx, call)
	_ = s.Audits.Finished(call, details, fileErr)
	if fileErr != nil {
		return nil, fileErr
	}
	return map[string]any{"content": content, "details": details}, nil
}
func (s *Service) CancelRun(identity RunIdentity) bool {
	foreground := s.Processes.CancelRun(identity)
	if s.Background == nil {
		return foreground
	}
	return s.Background.CancelRun(identity) && foreground
}
func decodeArguments(raw json.RawMessage, value any) error {
	if len(raw) == 0 {
		return errors.New("arguments are required")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return fmt.Errorf("invalid arguments: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("arguments must contain exactly one JSON value")
	}
	return nil
}

func processAuditSummary(value ProcessSnapshot) map[string]any {
	return map[string]any{"status": value.Status, "exit_code": value.ExitCode}
}
