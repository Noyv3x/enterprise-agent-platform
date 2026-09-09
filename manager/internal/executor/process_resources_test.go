package executor

import (
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/sandbox"
)

// Mirrors newTestService initialization for testing.B, using its existing fake
// Engine and active profile. Records are registered exactly as the in-memory
// process_recovery_test fixtures; there are no child processes or recovery files.
func resourceProcesses(tb testing.TB) *ProcessManager {
	tb.Helper()
	root := tb.TempDir()
	engine := engineStub{}
	sandboxes, err := sandbox.Open(testActiveProfile, engine, filepath.Join(root, "data"), filepath.Join(root, "manager", "sandboxes.json"), "registry/sandbox@sha256:"+strings.Repeat("a", 64), "network", time.Hour)
	if err != nil {
		tb.Fatal(err)
	}
	manager, err := NewProcessManager(testActiveProfile, engine, sandboxes, 64<<10)
	if err != nil {
		tb.Fatal(err)
	}
	output := []byte(strings.Repeat("x", 64<<10))
	for index := range 128 {
		id := fmt.Sprintf("proc_resources_%03d", index)
		scope := fmt.Sprintf("private:unrelated-%03d", index)
		if index == 0 {
			scope = "private:target"
		}
		stdout, stderr := &boundedBuffer{limit: 64 << 10}, &boundedBuffer{limit: 64 << 10}
		if _, err := stdout.Write(output); err != nil {
			tb.Fatal(err)
		}
		if _, err := stderr.Write(output); err != nil {
			tb.Fatal(err)
		}
		manager.processes[id] = &managedProcess{
			snapshot: ProcessSnapshot{
				ID: id, RunID: "run-resources", ScopeKey: scope, LifecycleID: "life-resources",
				Target: "sandbox", Command: "synthetic ordinary output", CWD: "/workspace",
				Status: "running", Background: index%2 == 0, StartedAt: time.Now().UTC(),
			},
			sandboxID: "private-1", workspaceID: "user-1",
			done: make(chan struct{}), stdout: stdout, stderr: stderr,
		}
	}
	return manager
}

func TestProcessCountsDoNotMaterializeOutput(t *testing.T) {
	manager := resourceProcesses(t)
	for _, test := range []struct {
		name  string
		count func() int
		want  int
	}{
		{"RunningCount", func() int { return manager.RunningCount("private:target", "life-resources") }, 1},
		{"ActiveBackgroundCount", manager.ActiveBackgroundCount, 64},
	} {
		t.Run(test.name, func(t *testing.T) {
			var before, after runtime.MemStats
			runtime.GC()
			runtime.ReadMemStats(&before)
			got := test.count()
			runtime.ReadMemStats(&after)
			allocated := after.TotalAlloc - before.TotalAlloc
			t.Logf("count=%d TotalAlloc delta=%d bytes; registered output=%d bytes", got, allocated, 128*2*(64<<10))
			if got != test.want {
				t.Errorf("count=%d, want %d", got, test.want)
			}
			// Counting metadata must not materialize the 16 MiB of ordinary output.
			if allocated > 1<<20 {
				t.Errorf("count allocated %d bytes, want <=1 MiB without materializing unrelated output", allocated)
			}
		})
	}
}

func TestPreviewOnlyMaterializesSelectedScopeOutput(t *testing.T) {
	manager := resourceProcesses(t)
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	preview := manager.Preview("private:target", "life-resources", "")
	runtime.ReadMemStats(&after)
	items := preview["processes"].([]map[string]any)
	if len(items) != 1 || items[0]["id"] != "proc_resources_000" {
		t.Fatalf("preview returned unrelated scope output: %#v", items)
	}
	if allocated := after.TotalAlloc - before.TotalAlloc; allocated > 1<<20 {
		t.Fatalf("single-scope preview allocated %d bytes for unrelated output", allocated)
	}
}

func BenchmarkProcessCounts(b *testing.B) {
	manager := resourceProcesses(b)
	b.Run("RunningCount", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for range b.N {
			if got := manager.RunningCount("private:target", "life-resources"); got != 1 {
				b.Fatalf("count=%d, want 1", got)
			}
		}
	})
	b.Run("ActiveBackgroundCount", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for range b.N {
			if got := manager.ActiveBackgroundCount(); got != 64 {
				b.Fatalf("count=%d, want 64", got)
			}
		}
	})
	b.Run("Preview", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for range b.N {
			manager.Preview("private:target", "life-resources", "")
		}
	})
}
