//go:build linux

package selfupdate

import (
	"bytes"
	"errors"
	"fmt"
	"sync"
)

// ObservationLease retains the self-update recovery exclusion while a source
// handoff proves that Current is stable and Candidate/Activation are absent.
// It is intentionally read-only and detects any writer that does not obey the
// recovery lock by comparing the exact state bytes before release.
type ObservationLease struct {
	manager *Manager
	data    []byte
	state   State
	release func()
	once    sync.Once
}

func (m *Manager) OpenObservation() (*ObservationLease, error) {
	if m == nil {
		return nil, errors.New("Manager self-update state is unavailable")
	}
	release, err := acquireRecoveryLock(m.Root)
	if err != nil {
		return nil, fmt.Errorf("acquire self-update observation lock: %w", err)
	}
	data, state, err := readRecoverySelfUpdateState(m.StatePath)
	if err != nil {
		release()
		return nil, err
	}
	return &ObservationLease{manager: m, data: data, state: state, release: release}, nil
}

func (lease *ObservationLease) State() State {
	if lease == nil {
		return State{}
	}
	return cloneObservationState(lease.state)
}

func (lease *ObservationLease) VerifyUnchanged() error {
	if lease == nil || lease.manager == nil {
		return errors.New("self-update observation lease is unavailable")
	}
	data, state, err := readRecoverySelfUpdateState(lease.manager.StatePath)
	if err != nil {
		return err
	}
	if !bytes.Equal(data, lease.data) || !statesEqualForObservation(state, lease.state) {
		return errors.New("Manager self-update state changed during the observation lease")
	}
	return nil
}

func (lease *ObservationLease) Close() error {
	if lease == nil {
		return nil
	}
	lease.once.Do(func() {
		if lease.release != nil {
			lease.release()
		}
		lease.release = nil
	})
	return nil
}

func cloneObservationState(value State) State {
	clone := value
	if value.Current != nil {
		current := *value.Current
		clone.Current = &current
	}
	if value.Previous != nil {
		previous := *value.Previous
		clone.Previous = &previous
	}
	if value.Candidate != nil {
		candidate := *value.Candidate
		clone.Candidate = &candidate
	}
	if value.Activation != nil {
		activation := *value.Activation
		clone.Activation = &activation
	}
	return clone
}

func statesEqualForObservation(left, right State) bool {
	// State contains only comparable values and pointers to comparable records;
	// compare the cloned pointed-to values explicitly.
	if left.SchemaVersion != right.SchemaVersion || left.UpdatedAt != right.UpdatedAt {
		return false
	}
	return versionsEqual(left.Current, right.Current) && versionsEqual(left.Previous, right.Previous) &&
		versionsEqual(left.Candidate, right.Candidate) && activationsEqual(left.Activation, right.Activation)
}

func versionsEqual(left, right *Version) bool {
	if left == nil || right == nil {
		return left == right
	}
	return *left == *right
}

func activationsEqual(left, right *Activation) bool {
	if left == nil || right == nil {
		return left == right
	}
	return *left == *right
}
