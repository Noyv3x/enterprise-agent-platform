package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"
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
	if call.CompletionRequired != (call.CompletionOwnerID != "") ||
		call.CompletionRequired && (!args.Background || !validCompletionOwner(call.CompletionOwnerID)) {
		return nil, errors.New("completion_owner_id requires a background command and a safe Runtime owner digest")
	}
	if err := validateTerminalArguments(args); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	// Admission spans receipt consumption and audit persistence so scope cleanup
	// cannot pass an already-entered terminal request that has not reached the
	// process registry yet.
	if err := s.Processes.reserveProcessSlot(call.ScopeID, call.LifecycleID); err != nil {
		return nil, err
	}
	admissionOwned := true
	defer func() {
		if admissionOwned {
			s.Processes.releaseProcessSlot(call.ScopeID, call.LifecycleID)
		}
	}()
	record, err := s.Audits.Consume(call, "terminal")
	if err != nil {
		return nil, err
	}
	if err := s.Audits.Started(call, map[string]any{"operation": record.Operation, "arguments": record.Details}); err != nil {
		return nil, err
	}
	admissionOwned = false
	result, runErr := s.Processes.runAdmitted(ctx, call, args)
	_ = s.Audits.Finished(call, processAuditSummary(result), runErr)
	if runErr != nil && result.ID == "" {
		return nil, runErr
	}
	return map[string]any{"result": result}, nil
}
func (s *Service) Process(ctx context.Context, call Call) (map[string]any, error) {
	switch call.Action {
	case "list", "read", "write", "kill", "wait":
	default:
		return nil, errors.New("unsupported process action")
	}
	var processID, input string
	waitTimeout := time.Duration(processWaitTimeoutDefaultMilliseconds) * time.Millisecond
	switch call.Action {
	case "list":
		var args struct{}
		if err := decodeArguments(call.Arguments, &args); err != nil {
			return nil, err
		}
	case "read", "kill":
		var args processIDArguments
		if err := decodeArguments(call.Arguments, &args); err != nil {
			return nil, err
		}
		processID = args.ProcessID
	case "write":
		var args processWriteArguments
		if err := decodeArguments(call.Arguments, &args); err != nil {
			return nil, err
		}
		processID, input = args.ProcessID, args.Input
	case "wait":
		var args processWaitArguments
		if err := decodeArguments(call.Arguments, &args); err != nil {
			return nil, err
		}
		processID = args.ProcessID
		if args.TimeoutMS != 0 {
			waitTimeout = time.Duration(args.TimeoutMS) * time.Millisecond
		}
		minimumWait := time.Duration(processWaitTimeoutMinimumMilliseconds) * time.Millisecond
		maximumWait := time.Duration(processWaitTimeoutMaximumMilliseconds) * time.Millisecond
		if waitTimeout < minimumWait || waitTimeout > maximumWait {
			return nil, fmt.Errorf(
				"timeout_ms must be between %d and %d",
				minimumWait.Milliseconds(),
				maximumWait.Milliseconds(),
			)
		}
	}
	if call.Action != "list" && processID == "" {
		return nil, errors.New("process_id is required")
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
		result, err = s.Processes.Get(call.ScopeID, call.LifecycleID, call.Target, processID)
	case "write":
		err = s.Processes.Write(call.ScopeID, call.LifecycleID, call.Target, processID, input)
		result = map[string]any{"message": "Input sent"}
	case "kill":
		result, err = s.Processes.Kill(call.ScopeID, call.LifecycleID, call.Target, processID)
	case "wait":
		result, err = s.Processes.Wait(
			ctx,
			call.ScopeID,
			call.LifecycleID,
			call.Target,
			call.ExecutionContext,
			processID,
			waitTimeout,
		)
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
	return s.Processes.CancelRun(identity)
}
func (s *Service) ReconcileTasks(identity TaskIdentity) ([]ProcessSnapshot, error) {
	if !validTaskIdentity(identity) {
		return nil, errors.New("task reconciliation identity is incomplete")
	}
	return s.Processes.ReconcileTasks(identity)
}
func (s *Service) AcknowledgeTask(identity TaskProcessIdentity) bool {
	if !validTaskIdentity(identity.TaskIdentity) || !validID(identity.ProcessID) {
		return false
	}
	return s.Processes.AcknowledgeTask(identity)
}

func validTaskIdentity(identity TaskIdentity) bool {
	return identity.ScopeID != "" && identity.LifecycleID != "" &&
		identity.ExecutionContext.SandboxID != "" && identity.ExecutionContext.WorkspaceID != "" &&
		validCompletionOwner(identity.CompletionOwnerID)
}
func (s *Service) CleanupScope(ctx context.Context, identity ScopeCleanupIdentity) (ScopeCleanupResult, error) {
	if identity.ScopeID == "" {
		return ScopeCleanupResult{}, errors.New("scope cleanup identity is incomplete")
	}
	return s.Processes.CleanupScopeWithEvidenceContext(ctx, identity.ScopeID, identity.LifecycleID)
}
func (s *Service) Preview(identity ScopeIdentity) map[string]any {
	return s.Processes.Preview(identity.ScopeID, identity.LifecycleID, identity.SinceRevision)
}
func (s *Service) Summary(identity ScopeIdentity) map[string]any {
	return map[string]any{"running_terminal_count": s.Processes.RunningCount(identity.ScopeID, identity.LifecycleID)}
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
	return map[string]any{"process_id": value.ID, "status": value.Status, "exit_code": value.ExitCode, "background": value.Background}
}
