package control

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/executor"
)

func mcpPost(t *testing.T, url, route string, body any, token string) (int, map[string]any) {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequestWithContext(context.Background(), http.MethodPost, url+"/v1/executor/mcp/"+route, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var decoded map[string]any
	_ = json.NewDecoder(response.Body).Decode(&decoded)
	return response.StatusCode, decoded
}

func mcpReceipt(t *testing.T, api *API, scope, action string, arguments map[string]any) executor.Call {
	t.Helper()
	streamCalls++
	id := "mcp-" + strconv.Itoa(streamCalls)
	raw, _ := json.Marshal(arguments)
	bound := executor.Identity{RunID: "run-1", ScopeID: scope, LifecycleID: "life-1", ToolCallID: id, ExecutionContext: executor.ExecutionContext{SandboxID: "private-1", WorkspaceID: "user-1"}}
	receipt, err := api.Executor.Audit(executor.AuditRequest{Identity: bound, AuditID: id, Target: "sandbox", Operation: "mcp", Action: action, Arguments: raw})
	if err != nil {
		t.Fatal(err)
	}
	return executor.Call{Identity: bound, AuditID: receipt.AuditID, ExecutorID: receipt.ExecutorID, Target: receipt.Target, Action: action, Arguments: raw}
}

const mcpEchoServer = `
import sys
for line in sys.stdin:
    sys.stdout.write(line); sys.stdout.flush()
`

func TestMCPRoutesEndToEnd(t *testing.T) {
	api := newStreamAPI(t)
	server := httptest.NewServer(api)
	defer server.Close()
	token := streamExecutorToken
	start := map[string]any{"connector_id": "conn-1", "command": "python3", "args": []string{"-u", "-c", mcpEchoServer}, "cwd": "", "env": map[string]string{"MCP_KEY": "v"}}

	if status, _ := mcpPost(t, server.URL, "recv", map[string]any{"connection_id": "x", "owner": "private:1"}, ""); status != http.StatusUnauthorized {
		t.Fatalf("MCP routes must require the executor bearer: %d", status)
	}
	status, body := mcpPost(t, server.URL, "start", mcpReceipt(t, api, "private:1/delegate/a", "start", start), token)
	if status != http.StatusOK || body["state"] != "running" {
		t.Fatalf("start: %d %v", status, body)
	}
	id := body["connection_id"].(string)
	if !strings.HasPrefix(id, "mcp_") {
		t.Fatalf("connection id: %q", id)
	}
	// A message whose JSON escaping exceeds the usual 2 MiB body limit still fits.
	message := `{"p":"` + strings.Repeat(`\"`, 450000) + `"}`
	if status, body := mcpPost(t, server.URL, "send", mcpReceipt(t, api, "private:1", "send", map[string]any{"connection_id": id, "message": message}), token); status != http.StatusOK || body["bytes"] != float64(len(message)) {
		t.Fatalf("send: %d %v", status, body)
	}
	var got map[string]any
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		_, got = mcpPost(t, server.URL, "recv", map[string]any{"connection_id": id, "owner": "private:1", "ack": 0, "wait_ms": 1000}, token)
		if len(got["messages"].([]any)) == 1 {
			break
		}
	}
	messages := got["messages"].([]any)
	if len(messages) != 1 || messages[0].(map[string]any)["data"] != message || got["state"] != "running" || got["next"] != float64(1) {
		t.Fatalf("recv: %v", got)
	}
	if status, _ := mcpPost(t, server.URL, "recv", map[string]any{"connection_id": id, "owner": "private:2"}, token); status != http.StatusNotFound {
		t.Fatalf("foreign owner must be 404: %d", status)
	}
	if status, _ := mcpPost(t, server.URL, "recv", map[string]any{"connection_id": "mcp_00000000000000000000000000", "owner": "private:1"}, token); status != http.StatusNotFound {
		t.Fatalf("unknown id must be 404: %d", status)
	}
	if status, _ := mcpPost(t, server.URL, "recv", map[string]any{"connection_id": id, "owner": "private:1", "ack": 1, "extra": 1}, token); status != http.StatusBadRequest {
		t.Fatalf("strict decoding: %d", status)
	}
	if status, _ := mcpPost(t, server.URL, "recv", map[string]any{"connection_id": id, "owner": "private:1", "ack": 9}, token); status != http.StatusConflict {
		t.Fatalf("bad ack: %d", status)
	}
	// The owner limit is 409; a receipt-less start is refused; a foreign stop is 404.
	status, second := mcpPost(t, server.URL, "start", mcpReceipt(t, api, "private:1", "start", start), token)
	if status != http.StatusOK {
		t.Fatalf("second start: %d %v", status, second)
	}
	if status, body := mcpPost(t, server.URL, "start", mcpReceipt(t, api, "private:1", "start", start), token); status != http.StatusConflict || !strings.Contains(body["error"].(string), "too many MCP connections") {
		t.Fatalf("limit: %d %v", status, body)
	}
	if status, _ := mcpPost(t, server.URL, "start", executor.Call{Target: "sandbox", Action: "start", Arguments: json.RawMessage(`{"connector_id":"c","command":"true"}`)}, token); status != http.StatusConflict {
		t.Fatalf("receipt-less start: %d", status)
	}
	if status, _ := mcpPost(t, server.URL, "stop", mcpReceipt(t, api, "private:2", "stop", map[string]any{"connection_id": id}), token); status != http.StatusNotFound {
		t.Fatalf("foreign stop: %d", status)
	}
	status, stopped := mcpPost(t, server.URL, "stop", mcpReceipt(t, api, "private:1", "stop", map[string]any{"connection_id": id}), token)
	if status != http.StatusOK || stopped["state"] != "exited" || stopped["reason"] != "stopped" {
		t.Fatalf("stop: %d %v", status, stopped)
	}
	_, after := mcpPost(t, server.URL, "recv", map[string]any{"connection_id": id, "owner": "private:1", "ack": 1}, token)
	if after["state"] != "exited" || after["reason"] != "stopped" {
		t.Fatalf("recv after stop: %v", after)
	}
	secondID := second["connection_id"].(string)
	if status, _ := mcpPost(t, server.URL, "stop", mcpReceipt(t, api, "private:1", "stop", map[string]any{"connection_id": secondID}), token); status != http.StatusOK {
		t.Fatalf("stop second: %d", status)
	}
}
