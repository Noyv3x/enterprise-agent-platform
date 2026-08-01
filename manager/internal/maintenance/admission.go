package maintenance

import (
	"sync"
	"sync/atomic"
)

// Admission serializes short lifecycle publication boundaries and exposes a
// monotonic epoch. Slow maintenance discovery runs without this lock; each
// destructive boundary must reacquire it and prove no intervening publisher
// crossed the boundary.
type Admission struct {
	mu    sync.Mutex
	epoch atomic.Uint64
}

func (a *Admission) Lock() { a.mu.Lock() }

func (a *Admission) Unlock() {
	a.epoch.Add(1)
	a.mu.Unlock()
}

// Epoch is safe both while the caller holds Admission and while unlocked.
func (a *Admission) Epoch() uint64 { return a.epoch.Load() }
