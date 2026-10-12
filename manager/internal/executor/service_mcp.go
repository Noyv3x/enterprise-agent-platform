package executor

import (
	"context"
	"errors"
)

var errMCPDisabled = errors.New("MCP stdio connections are not configured")

// mcpReceipt consumes the one-shot receipt of an MCP call and returns its audit
// details, which Audit derived from the very arguments the hash binds.
func (s *Service) mcpReceipt(call Call, action string) (map[string]any, error) {
	if call.Action != action {
		return nil, errors.New("MCP action must be " + action)
	}
	record, err := s.Audits.Consume(call, "mcp")
	if err != nil {
		return nil, err
	}
	return record.Details, nil
}

func (s *Service) MCPStart(ctx context.Context, call Call) (map[string]any, error) {
	if s.MCP == nil {
		return nil, errMCPDisabled
	}
	if call.Action != "start" {
		return nil, errors.New("MCP action must be start")
	}
	var args mcpStartArguments
	if err := decodeArguments(call.Arguments, &args); err != nil {
		return nil, err
	}
	if _, err := validateMCPStart(args); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	details, err := s.mcpReceipt(call, "start")
	if err != nil {
		return nil, err
	}
	if err := s.Audits.Started(call, map[string]any{"operation": "mcp", "arguments": details}); err != nil {
		return nil, err
	}
	id, err := s.MCP.Start(ctx, call, args)
	if err != nil {
		_ = s.Audits.Finished(call, map[string]any{"status": "failed"}, err)
		return nil, err
	}
	_ = s.Audits.Finished(call, map[string]any{"status": "running", "connection_id": id}, nil)
	return map[string]any{"connection_id": id, "state": "running"}, nil
}

func (s *Service) MCPSend(ctx context.Context, call Call) (map[string]any, error) {
	if s.MCP == nil {
		return nil, errMCPDisabled
	}
	if call.Action != "send" {
		return nil, errors.New("MCP action must be send")
	}
	var args mcpSendArguments
	if err := decodeArguments(call.Arguments, &args); err != nil {
		return nil, err
	}
	if err := s.MCP.CheckOwner(args.ConnectionID, call); err != nil {
		return nil, err
	}
	if err := validateMCPMessage(args.Message); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	details, err := s.mcpReceipt(call, "send")
	if err != nil {
		return nil, err
	}
	if details["connection_id"] != args.ConnectionID || !sameNumber(details["bytes"], len(args.Message)) {
		return nil, errors.New("MCP send audit projection does not match its arguments")
	}
	if err := s.Audits.Started(call, map[string]any{"operation": "mcp", "arguments": details}); err != nil {
		return nil, err
	}
	err = s.MCP.Send(call, args.ConnectionID, args.Message)
	_ = s.Audits.Finished(call, map[string]any{"connection_id": args.ConnectionID, "bytes": len(args.Message)}, err)
	if err != nil {
		return nil, err
	}
	return map[string]any{"connection_id": args.ConnectionID, "bytes": len(args.Message)}, nil
}

func (s *Service) MCPStop(ctx context.Context, call Call) (map[string]any, error) {
	if s.MCP == nil {
		return nil, errMCPDisabled
	}
	if call.Action != "stop" {
		return nil, errors.New("MCP action must be stop")
	}
	var args mcpStopArguments
	if err := decodeArguments(call.Arguments, &args); err != nil {
		return nil, err
	}
	if err := s.MCP.CheckOwner(args.ConnectionID, call); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	details, err := s.mcpReceipt(call, "stop")
	if err != nil {
		return nil, err
	}
	if details["connection_id"] != args.ConnectionID {
		return nil, errors.New("MCP stop audit projection does not match its arguments")
	}
	if err := s.Audits.Started(call, map[string]any{"operation": "mcp", "arguments": details}); err != nil {
		return nil, err
	}
	result, err := s.MCP.Stop(call, args.ConnectionID)
	summary := map[string]any{"connection_id": args.ConnectionID}
	if err == nil {
		summary["status"], summary["reason"] = result.State, result.Reason
	}
	_ = s.Audits.Finished(call, summary, err)
	if err != nil {
		return nil, err
	}
	return map[string]any{"connection_id": args.ConnectionID, "state": result.State, "reason": result.Reason}, nil
}

func (s *Service) MCPRecv(ctx context.Context, req MCPRecvRequest) (MCPRecvResult, error) {
	if s.MCP == nil {
		return MCPRecvResult{}, errMCPDisabled
	}
	return s.MCP.Recv(ctx, req)
}
