package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"unicode/utf8"
)

type Service struct {
	Audits    AuditStore
	Processes *ProcessManager
	Files     FileService
}

func (s *Service) Audit(request AuditRequest) (AuditReceipt, error) {
	presentation, err := projectMCPExecution(request.Details)
	if err != nil {
		return AuditReceipt{}, err
	}
	if presentation != nil {
		var args terminalArguments
		if request.Operation != "terminal" || request.Action != "run" || request.Target != "sandbox" || decodeArguments(request.Arguments, &args) != nil || args.Background {
			return AuditReceipt{}, errors.New("MCP execution must use a foreground sandbox terminal binding")
		}
		request.Details = presentation.Details
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
	presentation, err := projectMCPExecution(record.Details)
	if err != nil {
		return nil, err
	}
	if presentation != nil {
		if call.Target != "sandbox" || args.Background {
			return nil, errors.New("MCP execution must use a foreground sandbox terminal binding")
		}
		args.DisplayCommand = presentation.Command
		args.PrivateOutput = true
	} else {
		command, ok := record.Details["command"].(string)
		if !ok || command == "" {
			return nil, errors.New("terminal audit requires a safe command projection")
		}
		args.DisplayCommand = redactRetainedText(command)
	}
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

type mcpExecutionPresentation struct {
	Command string
	Details map[string]any
}

func projectMCPExecution(details map[string]any) (*mcpExecutionPresentation, error) {
	if details["tool"] != "mcp" {
		return nil, nil
	}
	action, ok := details["action"].(string)
	if !ok || action != "list" && action != "call" {
		return nil, errors.New("MCP audit projection has an invalid action")
	}
	arguments, ok := details["arguments"].(map[string]any)
	if !ok {
		return nil, errors.New("MCP audit projection is missing arguments")
	}
	projectedArguments := map[string]any{}
	command := "MCP " + action
	if serverValue, present := arguments["server"]; present {
		server, ok := serverValue.(string)
		if !ok || !validMCPServerID(server) {
			return nil, errors.New("MCP audit projection has an invalid server")
		}
		projectedArguments["server"] = server
		command += " server=" + strconv.QuoteToASCII(server)
	} else if action == "call" {
		return nil, errors.New("MCP call audit projection is missing server")
	}
	if action == "call" {
		tool, ok := arguments["tool"].(string)
		if !ok || !validMCPToolName(tool) {
			return nil, errors.New("MCP call audit projection has an invalid tool")
		}
		projectedArguments["tool"] = tool
		command += " tool=" + strconv.QuoteToASCII(tool)
	}
	return &mcpExecutionPresentation{
		Command: command,
		Details: map[string]any{"tool": "mcp", "action": action, "arguments": projectedArguments},
	}, nil
}

func validMCPServerID(value string) bool {
	if len(value) < 1 || len(value) > 64 {
		return false
	}
	for index, character := range value {
		if index == 0 && !(character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9') {
			return false
		}
		if !(character == '_' || character == '-' || character == '.' || character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9') {
			return false
		}
	}
	return true
}

func validMCPToolName(value string) bool {
	if !utf8.ValidString(value) || len(value) < 1 || len(value) > 256 {
		return false
	}
	for _, character := range value {
		if character <= 0x1f || character >= 0x7f && character <= 0x9f ||
			character == 0x00ad || character == 0x061c || character == 0x200b ||
			character == 0x200e || character == 0x200f || character >= 0x202a && character <= 0x202e ||
			character >= 0x2060 && character <= 0x2069 || character == 0xfeff {
			return false
		}
	}
	return true
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
	return s.Processes.CancelRun(identity)
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
