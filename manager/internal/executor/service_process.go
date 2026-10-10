package executor

import (
	"context"
	"errors"
	"fmt"
	"unicode/utf8"
)

var errBackgroundDisabled = errors.New("background processes are not configured")

// processReceipt consumes the one-shot receipt of a process call and returns
// its audited details after checking they describe these exact arguments.
func (s *Service) processReceipt(call Call, action string) (map[string]any, error) {
	if call.Action != action {
		return nil, fmt.Errorf("process action must be %s", action)
	}
	record, err := s.Audits.Consume(call, "process")
	if err != nil {
		return nil, err
	}
	return record.Details, nil
}

func (s *Service) ProcessStart(ctx context.Context, call Call) (map[string]any, error) {
	if s.Background == nil {
		return nil, errBackgroundDisabled
	}
	if call.Action != "start" {
		return nil, errors.New("process action must be start")
	}
	var args processStartArguments
	if err := decodeArguments(call.Arguments, &args); err != nil {
		return nil, err
	}
	if err := validateProcessStart(args); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	details, err := s.processReceipt(call, "start")
	if err != nil {
		return nil, err
	}
	command, ok := details["command"].(string)
	if !ok || command == "" {
		return nil, errors.New("process audit requires a safe command projection")
	}
	display := redactRetainedText(command)
	if err := s.Audits.Started(call, map[string]any{"operation": "process", "arguments": details}); err != nil {
		return nil, err
	}
	view, err := s.Background.Start(ctx, call, args, display)
	if err != nil {
		_ = s.Audits.Finished(call, map[string]any{"status": "failed"}, err)
		return nil, err
	}
	return map[string]any{"process": view}, nil
}

func (s *Service) ProcessStdin(ctx context.Context, call Call) (map[string]any, error) {
	if s.Background == nil {
		return nil, errBackgroundDisabled
	}
	if call.Action != "stdin" {
		return nil, errors.New("process action must be stdin")
	}
	var args processStdinArguments
	if err := decodeArguments(call.Arguments, &args); err != nil {
		return nil, err
	}
	owner := scopeFamilyRoot(call.ScopeID)
	if err := s.Background.CheckOwner(args.ProcessID, owner); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	details, err := s.processReceipt(call, "stdin")
	if err != nil {
		return nil, err
	}
	// The projection records the byte count only; it must match the data.
	if details["process_id"] != args.ProcessID || !sameNumber(details["bytes"], len(args.Data)) || !utf8.ValidString(args.Data) {
		return nil, errors.New("process stdin audit projection does not match its arguments")
	}
	if err := s.Audits.Started(call, map[string]any{"operation": "process", "arguments": details}); err != nil {
		return nil, err
	}
	view, err := s.Background.Stdin(args.ProcessID, owner, args.Data, args.EOF)
	_ = s.Audits.Finished(call, map[string]any{"process_id": args.ProcessID, "bytes": len(args.Data), "eof": args.EOF}, err)
	if err != nil {
		return nil, err
	}
	return map[string]any{"process": view}, nil
}

func (s *Service) ProcessKill(ctx context.Context, call Call) (map[string]any, error) {
	if s.Background == nil {
		return nil, errBackgroundDisabled
	}
	if call.Action != "kill" {
		return nil, errors.New("process action must be kill")
	}
	var args processKillArguments
	if err := decodeArguments(call.Arguments, &args); err != nil {
		return nil, err
	}
	owner := scopeFamilyRoot(call.ScopeID)
	if err := s.Background.CheckOwner(args.ProcessID, owner); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	details, err := s.processReceipt(call, "kill")
	if err != nil {
		return nil, err
	}
	if details["process_id"] != args.ProcessID {
		return nil, errors.New("process kill audit projection does not match its arguments")
	}
	if err := s.Audits.Started(call, map[string]any{"operation": "process", "arguments": details}); err != nil {
		return nil, err
	}
	view, err := s.Background.Kill(args.ProcessID, owner)
	summary := map[string]any{"process_id": args.ProcessID}
	if err == nil {
		summary["status"], summary["unconfirmed"] = view.State, view.Unconfirmed
	}
	_ = s.Audits.Finished(call, summary, err)
	if err != nil {
		return nil, err
	}
	return map[string]any{"process": view}, nil
}

func (s *Service) ProcessDetach(req ProcessDetachRequest) (map[string]any, error) {
	if s.Background == nil {
		return nil, errBackgroundDisabled
	}
	view, err := s.Background.Detach(req)
	if err != nil {
		return nil, err
	}
	return map[string]any{"process": view}, nil
}

func (s *Service) ProcessList(req ProcessListRequest) (map[string]any, error) {
	if s.Background == nil {
		return nil, errBackgroundDisabled
	}
	views, err := s.Background.List(req)
	if err != nil {
		return nil, err
	}
	return map[string]any{"processes": views}, nil
}

func (s *Service) ProcessRead(ctx context.Context, req ProcessReadRequest) (ProcessReadResult, error) {
	if s.Background == nil {
		return ProcessReadResult{}, errBackgroundDisabled
	}
	return s.Background.Read(ctx, req)
}

func (s *Service) ProcessChanges(ctx context.Context, req ProcessChangesRequest) (ProcessChangesResult, error) {
	if s.Background == nil {
		return ProcessChangesResult{}, errBackgroundDisabled
	}
	return s.Background.Changes(ctx, req)
}

func sameNumber(value any, want int) bool {
	switch number := value.(type) {
	case float64:
		return number == float64(want)
	case int:
		return number == want
	}
	return false
}
