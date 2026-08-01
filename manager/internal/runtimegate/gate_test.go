package runtimegate

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestFreezeWaitsForExistingRequestAndRejectsNewRequests(t *testing.T) {
	gate := New()
	releaseCall, err := gate.Enter(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	frozen := make(chan func(), 1)
	errorsSeen := make(chan error, 1)
	go func() {
		release, freezeErr := gate.Freeze(context.Background())
		if freezeErr != nil {
			errorsSeen <- freezeErr
			return
		}
		frozen <- release
	}()
	eventually(t, func() bool { return gate.Frozen() })
	if _, err := gate.Enter(context.Background()); !errors.Is(err, ErrFrozen) {
		t.Fatalf("new request during freeze = %v, want ErrFrozen", err)
	}
	select {
	case <-frozen:
		t.Fatal("freeze completed before the admitted request left")
	default:
	}
	releaseCall()
	var releaseFreeze func()
	select {
	case err := <-errorsSeen:
		t.Fatal(err)
	case releaseFreeze = <-frozen:
	case <-time.After(time.Second):
		t.Fatal("freeze did not observe the idle boundary")
	}
	if gate.Active() != 0 || !gate.Frozen() {
		t.Fatalf("gate boundary = active %d frozen %t", gate.Active(), gate.Frozen())
	}
	releaseFreeze()
	releaseFreeze()
	if release, err := gate.Enter(context.Background()); err != nil {
		t.Fatalf("request after release: %v", err)
	} else {
		release()
		release()
	}
}

func TestCancelledFreezeRestoresAdmission(t *testing.T) {
	gate := New()
	release, err := gate.Enter(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := gate.Freeze(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled freeze = %v", err)
	}
	release()
	if next, err := gate.Enter(context.Background()); err != nil {
		t.Fatalf("cancelled freeze left gate closed: %v", err)
	} else {
		next()
	}
}

func TestGateConcurrentEnterRelease(t *testing.T) {
	gate := New()
	var group sync.WaitGroup
	for index := 0; index < 64; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			for attempt := 0; attempt < 100; attempt++ {
				release, err := gate.Enter(context.Background())
				if errors.Is(err, ErrFrozen) {
					continue
				}
				if err != nil {
					t.Errorf("enter: %v", err)
					return
				}
				release()
			}
		}()
	}
	group.Wait()
	if gate.Active() != 0 {
		t.Fatalf("active calls leaked: %d", gate.Active())
	}
}

func eventually(t *testing.T, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for !predicate() {
		if time.Now().After(deadline) {
			t.Fatal("condition was not reached")
		}
		time.Sleep(time.Millisecond)
	}
}
