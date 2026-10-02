package control

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/executor"
	technicalidentity "github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/logstore"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/sandbox"
)

const streamExecutorToken = "executor-token-0123456789abcdef"

// hostExecEngine runs the sandbox wrapper directly on the host, like the
// executor package's own tests.
type hostExecEngine struct{ driver.Engine }

func (hostExecEngine) EnsureSandbox(context.Context, driver.SandboxSpec) error { return nil }
func (hostExecEngine) StopSandbox(context.Context, string) error               { return nil }
func (hostExecEngine) RemoveSandbox(context.Context, string) error             { return nil }
func (hostExecEngine) SandboxRunning(context.Context, string) (bool, error)    { return true, nil }
func (hostExecEngine) ExecArgs(_ driver.SandboxSpec, _ string, name string, args []string) (string, []string) {
	return name, args
}

func newStreamAPI(t *testing.T) *API {
	t.Helper()
	root := t.TempDir()
	profile := technicalidentity.CompileTimeActiveProfile()
	engine := hostExecEngine{}
	sandboxes, err := sandbox.Open(profile, engine, filepath.Join(root, "data"), filepath.Join(root, "manager", "sandboxes.json"), "registry/sandbox@sha256:"+strings.Repeat("a", 64), "network", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	processes, err := executor.NewProcessManager(profile, engine, sandboxes, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	files, err := executor.NewFileService(profile, sandboxes, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	service := &executor.Service{Audits: executor.AuditStore{Dir: filepath.Join(root, "control"), Log: logstore.New(filepath.Join(root, "audit.jsonl"), 1<<20, 2)}, Processes: processes, Files: files}
	return &API{Executor: service, ExecutorToken: streamExecutorToken}
}

var streamCalls int

func streamCall(t *testing.T, api *API, command string) []byte {
	t.Helper()
	streamCalls++
	id := "stream-" + strconv.Itoa(streamCalls)
	arguments, _ := json.Marshal(map[string]any{"command": command})
	bound := executor.Identity{RunID: "run-1", ScopeID: "private:1", LifecycleID: "life-1", ToolCallID: id, ExecutionContext: executor.ExecutionContext{SandboxID: "private-1", WorkspaceID: "user-1"}}
	receipt, err := api.Executor.Audit(executor.AuditRequest{Identity: bound, AuditID: id, Target: "sandbox", Operation: "terminal", Action: "run", Arguments: arguments, Details: map[string]any{"command": "[redacted]"}})
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(executor.Call{Identity: bound, AuditID: receipt.AuditID, ExecutorID: receipt.ExecutorID, Target: receipt.Target, Action: "run", Arguments: arguments})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func newTerminalRequest(t *testing.T, ctx context.Context, url string, body []byte, accept string) *http.Request {
	t.Helper()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url+"/v1/executor/terminal", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+streamExecutorToken)
	if accept != "" {
		request.Header.Set("Accept", accept)
	}
	return request
}

func TestTerminalNDJSONFramesFlushAndResultMatchesJSONMode(t *testing.T) {
	api := newStreamAPI(t)
	server := httptest.NewServer(api)
	defer server.Close()
	// The redactor withholds a 512-byte undecided suffix, so pad the first line.
	command := "printf '%0600d\\n' 0; sleep 0.8; printf 'Authorization: Bearer sec'; sleep 0.3; printf 'ret-canary\\nlast\\n'; printf warn >&2; exit 4"

	started := time.Now()
	response, err := http.DefaultClient.Do(newTerminalRequest(t, context.Background(), server.URL, streamCall(t, api, command), "application/x-ndjson"))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "application/x-ndjson" {
		t.Fatalf("status=%d content-type=%q", response.StatusCode, response.Header.Get("Content-Type"))
	}
	reader := bufio.NewReader(response.Body)
	var frames []map[string]any
	var firstAt time.Duration
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			var frame map[string]any
			if jsonErr := json.Unmarshal(line, &frame); jsonErr != nil {
				t.Fatalf("bad frame %q: %v", line, jsonErr)
			}
			if len(frames) == 0 {
				firstAt = time.Since(started)
			}
			frames = append(frames, frame)
		}
		if err != nil {
			break
		}
	}
	if firstAt > 600*time.Millisecond {
		t.Fatalf("first frame was not flushed before the command finished: %v", firstAt)
	}
	if len(frames) < 3 {
		t.Fatalf("too few frames: %v", frames)
	}
	last := frames[len(frames)-1]
	if last["type"] != "result" {
		t.Fatalf("last frame = %v", last)
	}
	var stdout, stderr strings.Builder
	for _, frame := range frames[:len(frames)-1] {
		if frame["type"] != "output" {
			t.Fatalf("unexpected frame %v", frame)
		}
		data := frame["data"].(string)
		for _, leak := range []string{"Bearer sec", "ret-canary"} {
			if strings.Contains(data, leak) {
				t.Fatalf("frame leaked secret fragment %q: %v", leak, frame)
			}
		}
		if frame["stream"] == "stdout" {
			stdout.WriteString(data)
		} else {
			stderr.WriteString(data)
		}
	}
	result := last["result"].(map[string]any)
	if result["stdout"] != stdout.String() || result["stderr"] != stderr.String() {
		t.Fatalf("frames differ from result: %q/%q vs %v", stdout.String(), stderr.String(), result)
	}

	// The same command in JSON mode returns the same object shape and content.
	plain, err := http.DefaultClient.Do(newTerminalRequest(t, context.Background(), server.URL, streamCall(t, api, command), ""))
	if err != nil {
		t.Fatal(err)
	}
	defer plain.Body.Close()
	if plain.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("JSON mode content-type = %q", plain.Header.Get("Content-Type"))
	}
	var body map[string]any
	if err := json.NewDecoder(plain.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if _, streamed := body["type"]; streamed || len(body) != 1 {
		t.Fatalf("JSON mode changed: %v", body)
	}
	expected := body["result"].(map[string]any)
	for _, object := range []map[string]any{expected, result} {
		delete(object, "started_at")
		delete(object, "finished_at")
	}
	got, _ := json.Marshal(result)
	want, _ := json.Marshal(expected)
	if !bytes.Equal(got, want) {
		t.Fatalf("result frame != JSON result:\n%s\n%s", got, want)
	}
}

func TestTerminalNDJSONFailureBeforeStreamingIsOrdinaryHTTPError(t *testing.T) {
	api := newStreamAPI(t)
	server := httptest.NewServer(api)
	defer server.Close()
	body := streamCall(t, api, "true")
	for range 2 { // the receipt is one-shot: the second call fails before any frame
		response, err := http.DefaultClient.Do(newTerminalRequest(t, context.Background(), server.URL, body, "application/x-ndjson"))
		if err != nil {
			t.Fatal(err)
		}
		status, contentType := response.StatusCode, response.Header.Get("Content-Type")
		response.Body.Close()
		if status == http.StatusConflict {
			if contentType != "application/json" {
				t.Fatalf("content-type = %q", contentType)
			}
			return
		}
	}
	t.Fatal("replayed receipt was accepted")
}

func TestTerminalNDJSONDisconnectCancelsCommand(t *testing.T) {
	api := newStreamAPI(t)
	server := httptest.NewServer(api)
	defer server.Close()
	marker := filepath.Join(t.TempDir(), "pid")
	command := "printf '%0600d\\n' 0; echo $$ > " + marker + "; sleep 60"
	ctx, cancel := context.WithCancel(context.Background())
	response, err := http.DefaultClient.Do(newTerminalRequest(t, ctx, server.URL, streamCall(t, api, command), "application/x-ndjson"))
	if err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(response.Body).ReadBytes('\n')
	if err != nil || !strings.Contains(string(line), "0000") {
		t.Fatalf("first frame = %q, %v", line, err)
	}
	cancel()
	response.Body.Close()
	var pid int
	until := time.Now().Add(5 * time.Second)
	for pid == 0 && time.Now().Before(until) {
		if data, err := os.ReadFile(marker); err == nil {
			pid, _ = strconv.Atoi(strings.TrimSpace(string(data)))
		}
		time.Sleep(20 * time.Millisecond)
	}
	if pid == 0 {
		t.Fatal("command did not record its pid")
	}
	for time.Now().Before(until.Add(10 * time.Second)) {
		if syscall.Kill(pid, 0) == syscall.ESRCH {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("disconnect did not terminate the command")
}
