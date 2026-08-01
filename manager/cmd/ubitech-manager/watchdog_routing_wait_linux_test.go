//go:build linux

package main

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
)

func TestWatchdogAuthorityRoutingWaitsForBusyOwnerThenReroutes(t *testing.T) {
	attempts := 0
	want := invocationStartup{stateHome: "/routed"}
	got, err := resolveWatchdogInvocationAuthority(
		context.Background(),
		"/manager.toml",
		time.Second,
		time.Millisecond,
		func(_ context.Context, configPath string) (invocationStartup, error) {
			attempts++
			if configPath != "/manager.toml" {
				t.Fatalf("config path = %q", configPath)
			}
			if attempts < 3 {
				return invocationStartup{}, fmt.Errorf("wrapped routing contention: %w", handoff.ErrBusy)
			}
			return want, nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if attempts != 3 || got.stateHome != want.stateHome {
		t.Fatalf("routing result = %+v after %d attempts", got, attempts)
	}
}

func TestWatchdogAuthorityRoutingFailsFastForNonBusyError(t *testing.T) {
	want := errors.New("invalid journal identity")
	attempts := 0
	_, err := resolveWatchdogInvocationAuthority(
		context.Background(),
		"/manager.toml",
		time.Second,
		time.Millisecond,
		func(context.Context, string) (invocationStartup, error) {
			attempts++
			return invocationStartup{}, want
		},
	)
	if !errors.Is(err, want) || attempts != 1 {
		t.Fatalf("non-busy routing error = %v after %d attempts", err, attempts)
	}
}

func TestWatchdogAuthorityRoutingStopsAtBoundedDeadline(t *testing.T) {
	attempts := 0
	_, err := resolveWatchdogInvocationAuthority(
		context.Background(),
		"/manager.toml",
		20*time.Millisecond,
		time.Millisecond,
		func(context.Context, string) (invocationStartup, error) {
			attempts++
			return invocationStartup{}, fmt.Errorf("still owned: %w", handoff.ErrBusy)
		},
	)
	if !errors.Is(err, handoff.ErrBusy) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("bounded routing error = %v", err)
	}
	if attempts < 2 {
		t.Fatalf("bounded routing attempts = %d, want at least 2", attempts)
	}
}

func TestWatchdogAuthorityRoutingHonorsCallerCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	attempts := 0
	_, err := resolveWatchdogInvocationAuthority(
		ctx,
		"/manager.toml",
		time.Hour,
		time.Hour,
		func(context.Context, string) (invocationStartup, error) {
			attempts++
			cancel()
			return invocationStartup{}, fmt.Errorf("temporarily owned: %w", handoff.ErrBusy)
		},
	)
	if !errors.Is(err, handoff.ErrBusy) || !errors.Is(err, context.Canceled) || attempts != 1 {
		t.Fatalf("cancelled routing error = %v after %d attempts", err, attempts)
	}
}
