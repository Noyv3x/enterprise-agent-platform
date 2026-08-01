// Package runtimegate provides the in-process execution boundary used while
// the source Manager takes a namespace-handoff observation. It deliberately
// contains no handoff or product identity logic, so executor routes and the
// handoff evidence owner can share it without an import cycle.
package runtimegate

import (
	"context"
	"errors"
	"sync"
)

var ErrFrozen = errors.New("runtime execution admission is temporarily frozen")

// Gate counts admitted executor calls and can atomically stop new calls while
// waiting for every already admitted call to leave. A durable background
// process outlives its creating HTTP call and is intentionally accounted for by
// the Sandbox/process registry evidence rather than by this in-memory gate.
type Gate struct {
	mu     sync.Mutex
	active int
	frozen bool
	idle   chan struct{}
}

func New() *Gate {
	idle := make(chan struct{})
	close(idle)
	return &Gate{idle: idle}
}

// Enter admits one complete executor request. Calls admitted before Freeze are
// allowed to finish; calls arriving after the freeze receive ErrFrozen and can
// be retried after the handoff observation boundary is released.
func (g *Gate) Enter(ctx context.Context) (func(), error) {
	if g == nil {
		return nil, errors.New("runtime execution admission is unavailable")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	g.mu.Lock()
	if g.frozen {
		g.mu.Unlock()
		return nil, ErrFrozen
	}
	if g.active == 0 {
		g.idle = make(chan struct{})
	}
	g.active++
	g.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			g.mu.Lock()
			if g.active > 0 {
				g.active--
				if g.active == 0 {
					close(g.idle)
				}
			}
			g.mu.Unlock()
		})
	}, nil
}

// Freeze closes admission before waiting for existing requests. Only one
// freezer can own the boundary; nested or competing freezes fail rather than
// sharing ambiguous ownership.
func (g *Gate) Freeze(ctx context.Context) (func(), error) {
	if g == nil {
		return nil, errors.New("runtime execution admission is unavailable")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	g.mu.Lock()
	if g.frozen {
		g.mu.Unlock()
		return nil, ErrFrozen
	}
	g.frozen = true
	for g.active != 0 {
		idle := g.idle
		g.mu.Unlock()
		select {
		case <-ctx.Done():
			g.mu.Lock()
			g.frozen = false
			g.mu.Unlock()
			return nil, ctx.Err()
		case <-idle:
		}
		g.mu.Lock()
	}
	g.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			g.mu.Lock()
			g.frozen = false
			g.mu.Unlock()
		})
	}, nil
}

func (g *Gate) Active() int {
	if g == nil {
		return 0
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.active
}

func (g *Gate) Frozen() bool {
	if g == nil {
		return false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.frozen
}
