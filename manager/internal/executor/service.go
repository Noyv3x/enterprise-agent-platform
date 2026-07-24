package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

type Service struct {
	Audits    AuditStore
	Processes *ProcessManager
	Files     FileService
}

func (s *Service) Audit(request AuditRequest) (AuditReceipt, error) { return s.Audits.Record(request) }
func (s *Service) Terminal(ctx context.Context, call Call) (map[string]any, error) {
	if call.Action != "run" {
		return nil, errors.New("terminal action must be run")
	}
	var args terminalArguments
	if err := decodeArguments(call.Arguments, &args); err != nil {
		return nil, err
	}
	record, err := s.Audits.Consume(call, "terminal")
	if err != nil {
		return nil, err
	}
	if err := s.Audits.Started(call, map[string]any{"operation": record.Operation, "arguments": record.Details}); err != nil {
		return nil, err
	}
	result, runErr := s.Processes.Run(ctx, call, args)
	_ = s.Audits.Finished(call, processAuditSummary(result), runErr)
	if runErr != nil && result.ID == "" {
		return nil, runErr
	}
	return map[string]any{"result": result}, nil
}
func (s *Service) Process(call Call) (map[string]any, error) {
	switch call.Action {
	case "list", "read", "write", "kill":
	default:
		return nil, errors.New("unsupported process action")
	}
	var args processArguments
	if err := decodeArguments(call.Arguments, &args); err != nil {
		return nil, err
	}
	record, err := s.Audits.Consume(call, "process")
	if err != nil {
		return nil, err
	}
	if err := s.Audits.Started(call, map[string]any{"operation": record.Operation, "arguments": record.Details}); err != nil {
		return nil, err
	}
	var result any
	switch call.Action {
	case "list":
		result = s.Processes.List(call.ScopeID, call.LifecycleID, call.Target)
	case "read":
		result, err = s.Processes.Get(call.ScopeID, call.LifecycleID, call.Target, args.ProcessID)
	case "write":
		err = s.Processes.Write(call.ScopeID, call.LifecycleID, call.Target, args.ProcessID, args.Input)
		result = map[string]any{"message": "Input sent"}
	case "kill":
		result, err = s.Processes.Kill(call.ScopeID, call.LifecycleID, call.Target, args.ProcessID)
	}
	_ = s.Audits.Finished(call, map[string]any{"action": call.Action, "succeeded": err == nil}, err)
	if err != nil {
		return nil, err
	}
	return map[string]any{"result": result}, nil
}
func (s *Service) File(ctx context.Context, call Call) (map[string]any, error) {
	allowed := map[string]string{"read": "read_file", "write": "write_file", "patch": "patch_file", "search": "search_files"}
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
	return s.Processes.CancelRun(identity.RunID, identity.ScopeID, identity.LifecycleID)
}
func (s *Service) CleanupScope(identity ScopeIdentity) bool {
	return s.Processes.CleanupScope(identity.ScopeID, identity.LifecycleID)
}
func (s *Service) Preview(identity ScopeIdentity) map[string]any {
	return s.Processes.Preview(identity.ScopeID, identity.LifecycleID, identity.SinceRevision)
}
func (s *Service) Summary(identity ScopeIdentity) map[string]any {
	return map[string]any{"running_terminal_count": s.Processes.RunningCount(identity.ScopeID, identity.LifecycleID)}
}
func (s *Service) UpdateBlockers() map[string]any {
	running, blocking, terminable := s.Processes.UpdateBlockers()
	return map[string]any{"running_background_terminal_count": running, "update_blocking_terminal_count": blocking, "terminable_background_terminal_count": terminable}
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
	return nil
}

func processAuditSummary(value ProcessSnapshot) map[string]any {
	return map[string]any{"process_id": value.ID, "status": value.Status, "exit_code": value.ExitCode, "background": value.Background}
}
