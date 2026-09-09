package operation

import (
	"context"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/journal"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

func TestStartExecutesOwnedPendingReplayOnce(t *testing.T) {
	server, url := testReleaseServer(t)
	defer server.Close()
	store, err := journal.Open(t.TempDir(), time.Unix(100, 0))
	if err != nil {
		t.Fatal(err)
	}
	request := model.OperationRequest{Kind: model.OperationUpdate, IdempotencyKey: "pending-replay", ExpectedGeneration: store.State().Generation, ManifestURL: url}
	pending, _, err := store.Begin(request, time.Unix(101, 0))
	if err != nil {
		t.Fatal(err)
	}
	engine := &fakeEngine{failAt: "prepare"}
	o := &Orchestrator{Store: store, Engine: engine, Gate: fakeGate{}, Snapshots: fakeSnapshot{}, ReleasesDir: t.TempDir(), ManifestURL: url, Channel: "main", ReleaseClient: release.Client{HTTP: server.Client()}}
	for range 2 {
		op, reused, err := o.Start(request)
		if err != nil || !reused || op.ID != pending.ID {
			t.Fatalf("replay replaced durable owner: %v %v %v", op, reused, err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	terminal, err := o.Await(ctx, pending.ID)
	if err != nil || terminal.Status != model.OperationFailed {
		t.Fatalf("pending owner was not executed: %v %v", terminal, err)
	}
	preparations := 0
	for _, call := range engine.calls {
		if call == "prepare" {
			preparations++
		}
	}
	if preparations != 1 {
		t.Fatalf("pending replay executed %d times", preparations)
	}
}
