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

func processPost(t *testing.T, url, route string, body any, token string) (int, map[string]any) {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequestWithContext(context.Background(), http.MethodPost, url+"/v1/executor/process/"+route, bytes.NewReader(data))
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

func processCall(t *testing.T, api *API, scope, action string, arguments, details map[string]any) executor.Call {
	t.Helper()
	streamCalls++
	id := "process-" + strconv.Itoa(streamCalls)
	raw, _ := json.Marshal(arguments)
	bound := executor.Identity{RunID: "run-1", ScopeID: scope, LifecycleID: "life-1", ToolCallID: id, ExecutionContext: executor.ExecutionContext{SandboxID: "private-1", WorkspaceID: "user-1"}}
	receipt, err := api.Executor.Audit(executor.AuditRequest{Identity: bound, AuditID: id, Target: "sandbox", Operation: "process", Action: action, Arguments: raw, Details: details})
	if err != nil {
		t.Fatal(err)
	}
	return executor.Call{Identity: bound, AuditID: receipt.AuditID, ExecutorID: receipt.ExecutorID, Target: receipt.Target, Action: action, Arguments: raw}
}

func TestProcessRoutesEndToEnd(t *testing.T) {
	api := newStreamAPI(t)
	server := httptest.NewServer(api)
	defer server.Close()
	token := streamExecutorToken

	if status, _ := processPost(t, server.URL, "list", map[string]any{"owner": "private:1"}, ""); status != http.StatusUnauthorized {
		t.Fatalf("process routes must require the executor bearer: %d", status)
	}
	status, body := processPost(t, server.URL, "start", processCall(t, api, "private:1/delegate/bg-2", "start", map[string]any{"command": "cat; echo bye", "timeout_ms": 0, "stdin": true, "attached": true}, map[string]any{"command": "cat; echo bye", "cwd": ""}), token)
	if status != http.StatusOK {
		t.Fatalf("start: %d %v", status, body)
	}
	view := body["process"].(map[string]any)
	id := view["id"].(string)
	if view["owner"] != "private:1" || view["state"] != "running" || view["stdin_open"] != true || view["name"] != nil {
		t.Fatalf("view: %v", view)
	}
	status, body = processPost(t, server.URL, "stdin", processCall(t, api, "private:1", "stdin", map[string]any{"process_id": id, "data": "hello\n", "eof": true}, map[string]any{"process_id": id, "bytes": 6}), token)
	if status != http.StatusOK {
		t.Fatalf("stdin: %d %v", status, body)
	}
	deadline := time.Now().Add(10 * time.Second)
	var read map[string]any
	for time.Now().Before(deadline) {
		_, read = processPost(t, server.URL, "read", map[string]any{"process_id": id, "owner": "private:1", "wait_ms": 1000}, token)
		if read["eof"] == true {
			break
		}
	}
	if read["data"] != "hello\nbye\n" || read["next_offset"] != float64(10) || read["retained_from"] != float64(0) || read["process"].(map[string]any)["state"] != "exited" {
		t.Fatalf("read: %v", read)
	}
	if status, body := processPost(t, server.URL, "read", map[string]any{"process_id": id, "owner": "private:2"}, token); status != http.StatusNotFound {
		t.Fatalf("owner mismatch must be 404: %d %v", status, body)
	}
	if status, _ := processPost(t, server.URL, "read", map[string]any{"process_id": id, "owner": "private:1", "unknown": 1}, token); status != http.StatusBadRequest {
		t.Fatalf("strict decoding: %d", status)
	}
	_, list := processPost(t, server.URL, "list", map[string]any{"owner": "private:1", "include_finished": true}, token)
	if processes := list["processes"].([]any); len(processes) != 1 {
		t.Fatalf("list: %v", list)
	}
	_, changes := processPost(t, server.URL, "changes", map[string]any{"after": 0}, token)
	if feed := changes["changes"].([]any); len(feed) != 1 || changes["next"] != feed[0].(map[string]any)["seq"] {
		t.Fatalf("changes: %v", changes)
	}
	// Limits and conflicts are 409; a receipt-less start is refused.
	for range 2 {
		if status, body := processPost(t, server.URL, "start", processCall(t, api, "private:1", "start", map[string]any{"command": "sleep 30", "stdin": false, "attached": false}, map[string]any{"command": "sleep 30"}), token); status != http.StatusOK {
			t.Fatalf("start: %d %v", status, body)
		}
	}
	status, body = processPost(t, server.URL, "start", processCall(t, api, "private:1", "start", map[string]any{"command": "sleep 30", "stdin": false, "attached": false}, map[string]any{"command": "sleep 30"}), token)
	if status != http.StatusConflict || !strings.Contains(body["error"].(string), "too many background processes") {
		t.Fatalf("limit: %d %v", status, body)
	}
	if status, _ := processPost(t, server.URL, "start", executor.Call{Target: "sandbox", Action: "start", Arguments: json.RawMessage(`{"command":"true"}`)}, token); status != http.StatusConflict {
		t.Fatalf("receipt-less start: %d", status)
	}
	_, running := processPost(t, server.URL, "list", map[string]any{"owner": "private:1"}, token)
	for _, item := range running["processes"].([]any) {
		pid := item.(map[string]any)["id"].(string)
		status, killed := processPost(t, server.URL, "kill", processCall(t, api, "private:1", "kill", map[string]any{"process_id": pid}, map[string]any{"process_id": pid}), token)
		if status != http.StatusOK || killed["process"].(map[string]any)["state"] != "killed" {
			t.Fatalf("kill: %d %v", status, killed)
		}
	}
	// Run cancellation covers attached processes through the existing route.
	status, body = processPost(t, server.URL, "start", processCall(t, api, "private:1", "start", map[string]any{"command": "sleep 30", "stdin": false, "attached": true}, map[string]any{"command": "sleep 30"}), token)
	if status != http.StatusOK {
		t.Fatalf("start: %d %v", status, body)
	}
	cancel := executor.RunIdentity{RunID: "run-1", ScopeID: "private:1", LifecycleID: "life-1", ExecutionContext: executor.ExecutionContext{SandboxID: "private-1", WorkspaceID: "user-1"}}
	data, _ := json.Marshal(cancel)
	request, _ := http.NewRequest(http.MethodPost, server.URL+"/v1/executor/runs/cancel", bytes.NewReader(data))
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	_, after := processPost(t, server.URL, "read", map[string]any{"process_id": body["process"].(map[string]any)["id"], "owner": "private:1"}, token)
	if state := after["process"].(map[string]any); state["state"] != "killed" || state["reason"] != "run_cancelled" {
		t.Fatalf("run cancel: %v", after)
	}
}
