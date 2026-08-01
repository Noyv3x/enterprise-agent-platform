//go:build linux

package handoff

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	globalLockName      = "global.lock"
	transactionLockName = "transaction.lock"
	journalName         = "journal.json"
	journalTempName     = "journal.tmp"
	atSymlinkNoFollow   = 0x100
	atRemovedir         = 0x200
)

var (
	ErrBusy                = errors.New("handoff journal ownership is busy")
	ErrNonTerminalExists   = errors.New("a nonterminal handoff transaction already exists")
	ErrMultipleNonTerminal = errors.New("multiple nonterminal handoff transactions exist")
	ErrNoJournals          = errors.New("handoff root contains no transaction journals")
	ErrRevisionConflict    = errors.New("handoff journal revision changed")
	ErrTerminal            = errors.New("handoff journal is terminal")
	ErrUnsafePath          = errors.New("unsafe handoff journal path")
)

type Store struct {
	root           string
	sourceDataRoot string
	targetDataRoot string
	rootFD         int
	mu             sync.Mutex
	closed         bool
}

// Open validates and opens a journal root already derived by the caller as
// <resolved-state-home>/agent-platform/handoff. It never reads HOME or XDG
// environment variables. The source data root must exist; the target may be
// absent, but its nearest existing parent must be owner-controlled.
func Open(root, sourceDataRoot, targetDataRoot string) (*Store, error) {
	if !canonicalAbsolutePath(root) || filepath.Base(root) != "handoff" || filepath.Base(filepath.Dir(root)) != "agent-platform" {
		return nil, fmt.Errorf("%w: journal root must be canonical <state-home>/agent-platform/handoff", ErrUnsafePath)
	}
	if !canonicalAbsolutePath(sourceDataRoot) || !canonicalAbsolutePath(targetDataRoot) {
		return nil, fmt.Errorf("%w: source and target data roots must be canonical absolute paths", ErrUnsafePath)
	}
	paths := []string{root, sourceDataRoot, targetDataRoot}
	for left := range paths {
		for right := left + 1; right < len(paths); right++ {
			if pathContains(paths[left], paths[right]) || pathContains(paths[right], paths[left]) {
				return nil, fmt.Errorf("%w: handoff journal, source, and target roots must not contain one another", ErrUnsafePath)
			}
		}
	}
	for _, path := range paths {
		if err := rejectSymlinkComponents(path); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrUnsafePath, err)
		}
	}
	if err := validateDataRoot(sourceDataRoot, true); err != nil {
		return nil, fmt.Errorf("%w: validate source data root: %v", ErrUnsafePath, err)
	}
	if err := validateDataRoot(targetDataRoot, false); err != nil {
		return nil, fmt.Errorf("%w: validate target data root: %v", ErrUnsafePath, err)
	}
	// Check the nearest existing journal ancestors before mkdirat can create an
	// object through a bind-mounted alias of either managed data root. The same
	// check is repeated after opening the final root to close replacement races.
	if err := rejectPhysicalContainment(root, sourceDataRoot, targetDataRoot); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnsafePath, err)
	}

	stateHome := filepath.Dir(filepath.Dir(root))
	stateFD, err := openOrCreateStateHome(stateHome)
	if err != nil {
		return nil, fmt.Errorf("%w: validate resolved state home: %v", ErrUnsafePath, err)
	}
	defer syscall.Close(stateFD)
	platformFD, err := ensureDirectoryAt(stateFD, stateHome, "agent-platform", true)
	if err != nil {
		return nil, fmt.Errorf("prepare handoff state namespace: %w", err)
	}
	defer syscall.Close(platformFD)
	rootFD, err := ensureDirectoryAt(platformFD, filepath.Join(stateHome, "agent-platform"), "handoff", true)
	if err != nil {
		return nil, fmt.Errorf("prepare handoff journal root: %w", err)
	}
	store := &Store{root: root, sourceDataRoot: sourceDataRoot, targetDataRoot: targetDataRoot, rootFD: rootFD}
	if err := store.verifyRoot(); err != nil {
		_ = store.Close()
		return nil, err
	}
	if err := rejectPhysicalContainment(root, sourceDataRoot, targetDataRoot); err != nil {
		_ = store.Close()
		return nil, fmt.Errorf("%w: %v", ErrUnsafePath, err)
	}
	lock, err := acquireLockAt(rootFD, globalLockName, "global handoff")
	if err != nil {
		_ = store.Close()
		return nil, err
	}
	releaseLock(lock)
	return store, nil
}

// openOrCreateStateHome supports the one P1 bootstrap gap: the default XDG
// state home may not exist yet.  Only the OS-account-derived ~/.local/state
// path is creatable; an explicit missing state_home remains fail closed.
func openOrCreateStateHome(stateHome string) (int, error) {
	fd, err := openOwnedDirectory(stateHome, false)
	if err == nil {
		return fd, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return -1, err
	}
	account, accountErr := user.Current()
	if accountErr != nil {
		return -1, fmt.Errorf("resolve operating-system account: %w", accountErr)
	}
	home := filepath.Clean(account.HomeDir)
	if account.Uid != strconv.Itoa(os.Getuid()) || account.HomeDir != home || !canonicalAbsolutePath(home) || home == string(filepath.Separator) {
		return -1, errors.New("operating-system account home is invalid")
	}
	return openOrCreateDefaultStateHome(stateHome, home)
}

func openOrCreateDefaultStateHome(stateHome, home string) (int, error) {
	if stateHome != filepath.Join(home, ".local", "state") {
		return -1, errors.New("explicit XDG state home does not exist")
	}
	if err := rejectSymlinkComponents(home); err != nil {
		return -1, err
	}
	homeFD, err := openOwnedDirectory(home, false)
	if err != nil {
		return -1, fmt.Errorf("open operating-system account home: %w", err)
	}
	defer syscall.Close(homeFD)
	localFD, err := ensureDirectoryAt(homeFD, home, ".local", false)
	if err != nil {
		return -1, fmt.Errorf("prepare default XDG local directory: %w", err)
	}
	defer syscall.Close(localFD)
	stateFD, err := ensureDirectoryAt(localFD, filepath.Join(home, ".local"), "state", false)
	if err != nil {
		return -1, fmt.Errorf("prepare default XDG state home: %w", err)
	}
	return stateFD, nil
}

// OpenExisting opens a previously initialized handoff Store for terminal
// startup routing without trusting either technical profile's config file as
// a path selector. It creates nothing: the root, global lock, and at least one
// valid journal must already exist. Source and target roots are learned only
// from the closed journal schema while the existing global lock is retained,
// must agree across every transaction, and are then subjected to the same
// lexical and physical boundary checks as Open.
func OpenExisting(root string) (*Store, error) {
	if !canonicalAbsolutePath(root) || filepath.Base(root) != "handoff" || filepath.Base(filepath.Dir(root)) != "agent-platform" {
		return nil, fmt.Errorf("%w: existing journal root must be canonical <state-home>/agent-platform/handoff", ErrUnsafePath)
	}
	if err := rejectSymlinkComponents(root); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnsafePath, err)
	}
	stateHome := filepath.Dir(filepath.Dir(root))
	stateFD, err := openOwnedDirectory(stateHome, false)
	if err != nil {
		return nil, fmt.Errorf("%w: validate resolved state home: %v", ErrUnsafePath, err)
	}
	defer syscall.Close(stateFD)
	platformFD, err := openDirectoryAt(stateFD, "agent-platform", true)
	if err != nil {
		return nil, fmt.Errorf("open existing handoff state namespace: %w", err)
	}
	defer syscall.Close(platformFD)
	rootFD, err := openDirectoryAt(platformFD, "handoff", true)
	if err != nil {
		return nil, fmt.Errorf("open existing handoff journal root: %w", err)
	}
	store := &Store{root: root, rootFD: rootFD}
	if err := store.verifyRoot(); err != nil {
		_ = store.Close()
		return nil, err
	}
	global, err := acquireExistingLockAt(rootFD, globalLockName, "global handoff")
	if err != nil {
		_ = store.Close()
		return nil, err
	}
	sourceRoot, targetRoot, bindingErr := existingJournalRootsLocked(rootFD)
	releaseLock(global)
	if bindingErr != nil {
		_ = store.Close()
		return nil, bindingErr
	}
	store.sourceDataRoot = sourceRoot
	store.targetDataRoot = targetRoot
	if err := store.verifyBoundaries(); err != nil {
		_ = store.Close()
		return nil, err
	}
	return store, nil
}

func existingJournalRootsLocked(rootFD int) (string, string, error) {
	entries, err := readDirectory(rootFD)
	if err != nil {
		return "", "", fmt.Errorf("enumerate existing handoff journals: %w", err)
	}
	sort.Slice(entries, func(left, right int) bool { return entries[left].Name() < entries[right].Name() })
	var sourceRoot, targetRoot string
	found := false
	for _, entry := range entries {
		name := entry.Name()
		if name == globalLockName {
			continue
		}
		if !transactionIDPattern.MatchString(name) {
			return "", "", fmt.Errorf("unknown handoff journal root entry %q", name)
		}
		txFD, err := openTransactionDir(rootFD, name)
		if err != nil {
			return "", "", err
		}
		journal, readErr := readJournalAt(txFD)
		_ = syscall.Close(txFD)
		if readErr != nil {
			return "", "", readErr
		}
		if journal.TransactionID != name {
			return "", "", errors.New("handoff transaction directory and journal identity differ")
		}
		if !found {
			sourceRoot, targetRoot = journal.Source.DataRoot, journal.Target.DataRoot
			found = true
		} else if sourceRoot != journal.Source.DataRoot || targetRoot != journal.Target.DataRoot {
			return "", "", errors.New("handoff journals disagree on deployment data roots")
		}
	}
	if !found {
		return "", "", ErrNoJournals
	}
	if !canonicalAbsolutePath(sourceRoot) || !canonicalAbsolutePath(targetRoot) {
		return "", "", errors.New("existing handoff journal data roots are invalid")
	}
	return sourceRoot, targetRoot, nil
}

func (s *Store) Root() string { return s.root }

func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	return syscall.Close(s.rootFD)
}

func (s *Store) duplicateRootFD() (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return -1, errors.New("handoff journal store is closed")
	}
	if err := s.verifyRoot(); err != nil {
		return -1, err
	}
	if err := s.verifyBoundaries(); err != nil {
		return -1, err
	}
	fd, err := syscall.Dup(s.rootFD)
	if err != nil {
		return -1, fmt.Errorf("duplicate handoff journal root: %w", err)
	}
	return fd, nil
}

func (s *Store) verifyBoundaries() error {
	for _, path := range []string{s.root, s.sourceDataRoot, s.targetDataRoot} {
		if err := rejectSymlinkComponents(path); err != nil {
			return fmt.Errorf("%w: %v", ErrUnsafePath, err)
		}
	}
	if err := validateDataRoot(s.sourceDataRoot, true); err != nil {
		return fmt.Errorf("%w: validate source data root: %v", ErrUnsafePath, err)
	}
	if err := validateDataRoot(s.targetDataRoot, false); err != nil {
		return fmt.Errorf("%w: validate target data root: %v", ErrUnsafePath, err)
	}
	if err := rejectPhysicalContainment(s.root, s.sourceDataRoot, s.targetDataRoot); err != nil {
		return fmt.Errorf("%w: %v", ErrUnsafePath, err)
	}
	return nil
}

func (s *Store) verifyRoot() error {
	return verifyRootFD(s.root, s.rootFD)
}

func verifyRootFD(root string, rootFD int) error {
	var opened syscall.Stat_t
	if err := syscall.Fstat(rootFD, &opened); err != nil {
		return fmt.Errorf("inspect opened handoff journal root: %w", err)
	}
	info, err := os.Lstat(root)
	if err != nil {
		return fmt.Errorf("inspect handoff journal root: %w", err)
	}
	observed, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || observed.Dev != opened.Dev || observed.Ino != opened.Ino ||
		opened.Uid != uint32(os.Getuid()) || opened.Mode&0o777 != 0o700 {
		return fmt.Errorf("%w: handoff journal root changed or is not an owner-only directory", ErrUnsafePath)
	}
	return nil
}

// Create persists a planned journal. It is the sole source-side write; every
// subsequent mutation requires an acquired Helper lease.
func (s *Store) Create(j Journal) (Journal, error) {
	created, existing, err := s.CreatePlanned(func() (Journal, error) { return j, nil })
	if err != nil {
		return Journal{}, err
	}
	if existing {
		return Journal{}, ErrNonTerminalExists
	}
	return created, nil
}

// CreatePlanned holds the deployment-wide handoff lock while it proves that
// no nonterminal transaction exists, calls build, validates the resulting
// pristine journal, and persists it. The callback is deliberately invoked
// under the retained global lock so a caller can acquire the ordinary runtime
// admission lease in the mandated handoff -> runtime order and keep that lease
// until this method returns. This closes the check/preflight/create race that
// separate DiscoverNonTerminal and Create calls cannot close.
//
// When a nonterminal transaction already exists, build is not called and the
// existing journal is returned with existing=true.
func (s *Store) CreatePlanned(build func() (Journal, error)) (created Journal, existing bool, resultErr error) {
	if build == nil {
		return Journal{}, false, errors.New("handoff planned journal builder is required")
	}
	rootFD, err := s.duplicateRootFD()
	if err != nil {
		return Journal{}, false, err
	}
	defer syscall.Close(rootFD)
	global, err := acquireLockAt(rootFD, globalLockName, "global handoff")
	if err != nil {
		return Journal{}, false, err
	}
	defer releaseLock(global)
	if current, found, err := discoverNonTerminalLocked(rootFD, s); err != nil {
		return Journal{}, false, err
	} else if found {
		return current, true, nil
	}
	j, err := build()
	if err != nil {
		return Journal{}, false, err
	}
	if err := s.validatePlannedJournal(j); err != nil {
		return Journal{}, false, err
	}
	created, err = s.createPlannedLocked(rootFD, j)
	return created, false, err
}

func (s *Store) validatePlannedJournal(j Journal) error {
	if err := Validate(j); err != nil {
		return err
	}
	if j.Revision != 1 || j.Phase != PhasePlanned || j.Status != StatusRunning || j.DesiredOutcome != OutcomeForward ||
		j.Snapshot != nil || j.Helper != nil || j.TargetAck != nil || j.TargetPlatformCommit != nil ||
		j.AbortCleanup != nil || j.CompletedAt != nil || j.Error != "" {
		return errors.New("handoff journal Create requires the pristine planned state")
	}
	if j.Source.DataRoot != s.sourceDataRoot || j.Target.DataRoot != s.targetDataRoot {
		return errors.New("handoff journal data roots do not match the opened store")
	}
	return nil
}

func (s *Store) createPlannedLocked(rootFD int, j Journal) (Journal, error) {
	if err := syscall.Mkdirat(rootFD, j.TransactionID, 0o700); err != nil {
		if errors.Is(err, syscall.EEXIST) {
			return Journal{}, errors.New("handoff transaction id already exists")
		}
		return Journal{}, fmt.Errorf("create handoff transaction directory: %w", err)
	}
	if err := syscall.Fsync(rootFD); err != nil {
		_ = unlinkat(rootFD, j.TransactionID, atRemovedir)
		return Journal{}, fmt.Errorf("sync handoff journal root: %w", err)
	}
	txFD, err := openNewTransactionDir(rootFD, j.TransactionID)
	if err != nil {
		_ = unlinkat(rootFD, j.TransactionID, atRemovedir)
		return Journal{}, err
	}
	defer syscall.Close(txFD)
	txLock, err := acquireLockAt(txFD, transactionLockName, "transaction handoff")
	if err != nil {
		s.cleanupNewTransaction(rootFD, txFD, j.TransactionID)
		return Journal{}, err
	}
	defer releaseLock(txLock)
	if err := writeJournalAt(txFD, j, false); err != nil {
		s.cleanupNewTransaction(rootFD, txFD, j.TransactionID)
		return Journal{}, err
	}
	return cloneJournal(j), nil
}

func (s *Store) cleanupNewTransaction(rootFD, txFD int, transactionID string) {
	_ = syscall.Unlinkat(txFD, journalTempName)
	_ = syscall.Unlinkat(txFD, journalName)
	_ = syscall.Unlinkat(txFD, transactionLockName)
	_ = syscall.Fsync(txFD)
	_ = unlinkat(rootFD, transactionID, atRemovedir)
	_ = syscall.Fsync(rootFD)
}

func (s *Store) Load(transactionID string) (Journal, error) {
	if !transactionIDPattern.MatchString(transactionID) {
		return Journal{}, errors.New("invalid handoff transaction id")
	}
	rootFD, err := s.duplicateRootFD()
	if err != nil {
		return Journal{}, err
	}
	defer syscall.Close(rootFD)
	global, err := acquireLockAt(rootFD, globalLockName, "global handoff")
	if err != nil {
		return Journal{}, err
	}
	defer releaseLock(global)
	return loadTransactionLocked(rootFD, transactionID, s)
}

func (s *Store) DiscoverNonTerminal() (Journal, bool, error) {
	rootFD, err := s.duplicateRootFD()
	if err != nil {
		return Journal{}, false, err
	}
	defer syscall.Close(rootFD)
	global, err := acquireLockAt(rootFD, globalLockName, "global handoff")
	if err != nil {
		return Journal{}, false, err
	}
	defer releaseLock(global)
	return discoverNonTerminalLocked(rootFD, s)
}

// Observation holds the retained root directory and deployment-wide handoff
// lock while a receipt observer freezes ordinary-operation admission. It is a
// read-only lease: journal bytes are always opened relative to the retained
// root descriptor and decoded by the Store's canonical strict decoder. This
// prevents a same-UID pathname swap from splicing an unlocked journal tree
// into a receipt observation.
type Observation struct {
	store      *Store
	rootFD     int
	globalLock *os.File
	mu         sync.Mutex
	closed     bool
}

// OpenObservation acquires the global singleton and returns the first exact
// journal snapshot. Callers must Close the lease. While it remains open no
// helper, new transaction, or other observation can acquire handoff ownership.
func (s *Store) OpenObservation() (*Observation, []Journal, error) {
	rootFD, err := s.duplicateRootFD()
	if err != nil {
		return nil, nil, err
	}
	global, err := acquireLockAt(rootFD, globalLockName, "global handoff observation")
	if err != nil {
		_ = syscall.Close(rootFD)
		return nil, nil, err
	}
	lease := &Observation{store: s, rootFD: rootFD, globalLock: global}
	journals, err := lease.readLocked()
	if err != nil {
		_ = lease.Close()
		return nil, nil, err
	}
	return lease, journals, nil
}

// Read re-observes every journal through the same retained root descriptor.
func (o *Observation) Read() ([]Journal, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.closed {
		return nil, errors.New("handoff observation lease is closed")
	}
	return o.readLocked()
}

func (o *Observation) readLocked() ([]Journal, error) {
	if err := verifyRootFD(o.store.root, o.rootFD); err != nil {
		return nil, err
	}
	if err := o.store.verifyBoundaries(); err != nil {
		return nil, err
	}
	entries, err := readDirectory(o.rootFD)
	if err != nil {
		return nil, fmt.Errorf("enumerate handoff observation journals: %w", err)
	}
	sort.Slice(entries, func(left, right int) bool { return entries[left].Name() < entries[right].Name() })
	journals := make([]Journal, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if name == globalLockName {
			continue
		}
		if !transactionIDPattern.MatchString(name) {
			return nil, fmt.Errorf("unknown handoff journal root entry %q", name)
		}
		txFD, err := openTransactionDir(o.rootFD, name)
		if err != nil {
			return nil, err
		}
		journal, readErr := readJournalAt(txFD)
		_ = syscall.Close(txFD)
		if readErr != nil {
			return nil, readErr
		}
		if journal.TransactionID != name || journal.Source.DataRoot != o.store.sourceDataRoot || journal.Target.DataRoot != o.store.targetDataRoot {
			return nil, errors.New("handoff observation journal binding changed")
		}
		journals = append(journals, cloneJournal(journal))
	}
	return journals, nil
}

func (o *Observation) Close() error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.closed {
		return nil
	}
	o.closed = true
	releaseLock(o.globalLock)
	return syscall.Close(o.rootFD)
}

func discoverNonTerminalLocked(rootFD int, store *Store) (Journal, bool, error) {
	entries, err := readDirectory(rootFD)
	if err != nil {
		return Journal{}, false, fmt.Errorf("enumerate handoff journals: %w", err)
	}
	sort.Slice(entries, func(left, right int) bool { return entries[left].Name() < entries[right].Name() })
	var discovered *Journal
	for _, entry := range entries {
		name := entry.Name()
		if name == globalLockName {
			continue
		}
		if !transactionIDPattern.MatchString(name) {
			return Journal{}, false, fmt.Errorf("unknown handoff journal root entry %q", name)
		}
		journal, err := loadTransactionLocked(rootFD, name, store)
		if err != nil {
			return Journal{}, false, err
		}
		if journal.Terminal() {
			continue
		}
		if discovered != nil {
			return Journal{}, false, ErrMultipleNonTerminal
		}
		copy := cloneJournal(journal)
		discovered = &copy
	}
	if discovered == nil {
		return Journal{}, false, nil
	}
	return *discovered, true, nil
}

func loadTransactionLocked(rootFD int, transactionID string, store *Store) (Journal, error) {
	txFD, err := openTransactionDir(rootFD, transactionID)
	if err != nil {
		return Journal{}, err
	}
	defer syscall.Close(txFD)
	lock, err := acquireLockAt(txFD, transactionLockName, "transaction handoff")
	if err != nil {
		return Journal{}, err
	}
	defer releaseLock(lock)
	journal, err := readJournalAt(txFD)
	if err != nil {
		return Journal{}, err
	}
	if journal.TransactionID != transactionID {
		return Journal{}, errors.New("handoff transaction directory and journal identity differ")
	}
	if journal.Source.DataRoot != store.sourceDataRoot || journal.Target.DataRoot != store.targetDataRoot {
		return Journal{}, errors.New("handoff journal data roots do not match the opened store")
	}
	return journal, nil
}

// Helper holds the global singleton and transaction lock in the mandated
// order. It is the only exported writer after Create and is safe for concurrent
// goroutines; expected-revision CAS still permits only one winner.
type Helper struct {
	store         *Store
	transactionID string
	rootFD        int
	txFD          int
	globalLock    *os.File
	txLock        *os.File
	mu            sync.Mutex
	closed        bool
}

// StartupLease is a read-only capability derived from the helper's already
// held writer lease.  Participant startup code can re-read the exact locked
// journal without receiving Mutate or an entry point that reacquires Store
// locks.  The capability becomes unusable as soon as its parent Helper closes.
type StartupLease struct {
	helper *Helper
}

// StartupLease returns an opaque read-only view of this helper lease.
func (h *Helper) StartupLease() StartupLease { return StartupLease{helper: h} }

// Load revalidates and reads the journal through the parent helper's retained
// descriptors and locks.
func (lease StartupLease) Load() (Journal, error) {
	if lease.helper == nil {
		return Journal{}, errors.New("handoff startup lease is unavailable")
	}
	return lease.helper.Load()
}

func (s *Store) OpenHelper(transactionID string) (*Helper, Journal, error) {
	if !transactionIDPattern.MatchString(transactionID) {
		return nil, Journal{}, errors.New("invalid handoff transaction id")
	}
	rootFD, err := s.duplicateRootFD()
	if err != nil {
		return nil, Journal{}, err
	}
	global, err := acquireLockAt(rootFD, globalLockName, "global handoff")
	if err != nil {
		syscall.Close(rootFD)
		return nil, Journal{}, err
	}
	txFD, err := openTransactionDir(rootFD, transactionID)
	if err != nil {
		releaseLock(global)
		syscall.Close(rootFD)
		return nil, Journal{}, err
	}
	txLock, err := acquireLockAt(txFD, transactionLockName, "transaction handoff")
	if err != nil {
		syscall.Close(txFD)
		releaseLock(global)
		syscall.Close(rootFD)
		return nil, Journal{}, err
	}
	helper := &Helper{store: s, transactionID: transactionID, rootFD: rootFD, txFD: txFD, globalLock: global, txLock: txLock}
	journal, err := helper.loadLocked()
	if err != nil {
		_ = helper.Close()
		return nil, Journal{}, err
	}
	return helper, journal, nil
}

func (h *Helper) Close() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil
	}
	h.closed = true
	releaseLock(h.txLock)
	_ = syscall.Close(h.txFD)
	releaseLock(h.globalLock)
	return syscall.Close(h.rootFD)
}

func (h *Helper) Load() (Journal, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return Journal{}, errors.New("handoff helper lease is closed")
	}
	return h.loadLocked()
}

func (h *Helper) loadLocked() (Journal, error) {
	if err := verifyRootFD(h.store.root, h.rootFD); err != nil {
		return Journal{}, err
	}
	if err := verifyDirectoryAt(h.rootFD, h.transactionID, h.txFD, true); err != nil {
		return Journal{}, err
	}
	if err := h.store.verifyBoundaries(); err != nil {
		return Journal{}, err
	}
	journal, err := readJournalAt(h.txFD)
	if err != nil {
		return Journal{}, err
	}
	if journal.TransactionID != h.transactionID || journal.Source.DataRoot != h.store.sourceDataRoot || journal.Target.DataRoot != h.store.targetDataRoot {
		return Journal{}, errors.New("handoff helper journal binding changed")
	}
	return journal, nil
}

// Mutate applies one CAS-protected journal change. Phase history and durable
// timestamps are Store-owned. A no-op terminal replay succeeds even with a
// stale expected revision; every attempted terminal change fails.
func (h *Helper) Mutate(expectedRevision uint64, now time.Time, mutate func(*Journal) error) (Journal, error) {
	if mutate == nil {
		return Journal{}, errors.New("handoff mutation callback is required")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return Journal{}, errors.New("handoff helper lease is closed")
	}
	current, err := h.loadLocked()
	if err != nil {
		return Journal{}, err
	}
	next := cloneJournal(current)
	if err := mutate(&next); err != nil {
		return Journal{}, err
	}
	if !sameStoreOwnedFields(current, next) {
		return Journal{}, errors.New("handoff mutation changed Store-owned fields")
	}
	if current.Terminal() {
		if reflect.DeepEqual(current, next) {
			return current, nil
		}
		return Journal{}, ErrTerminal
	}
	if expectedRevision != current.Revision {
		return Journal{}, ErrRevisionConflict
	}
	if reflect.DeepEqual(current, next) {
		return current, nil
	}
	if !sameImmutableBinding(current, next) {
		return Journal{}, errors.New("handoff mutation changed immutable binding or planned evidence")
	}
	if err := validateWriteOnce(current, next); err != nil {
		return Journal{}, err
	}
	if err := validateEvidenceIntroduction(current, next); err != nil {
		return Journal{}, err
	}
	if !validTransition(current.Phase, next.Phase) {
		return Journal{}, fmt.Errorf("illegal handoff phase transition %s -> %s", current.Phase, next.Phase)
	}
	if next.Error != current.Error && next.Error != "" && historyContains(current.History, PhaseSourceFenced) &&
		current.DesiredOutcome == OutcomeForward && current.Phase != PhaseTargetCommitPlanned {
		next.DesiredOutcome = OutcomeRollback
		next.Status = StatusRecovering
		next.Phase = PhaseRollbackPlanned
	}
	if !validTransition(current.Phase, next.Phase) {
		return Journal{}, fmt.Errorf("illegal handoff phase transition %s -> %s", current.Phase, next.Phase)
	}
	now = now.UTC()
	if now.IsZero() || now.Before(current.UpdatedAt) {
		return Journal{}, errors.New("handoff mutation timestamp regressed")
	}
	if next.Phase != current.Phase {
		next.History = append(next.History, PhaseEvent{Phase: next.Phase, At: now, Note: ""})
	}
	next.Revision = current.Revision + 1
	next.UpdatedAt = now
	if next.Status.Terminal() {
		completed := now
		next.CompletedAt = &completed
	} else {
		next.CompletedAt = nil
	}
	if err := Validate(next); err != nil {
		return Journal{}, err
	}
	if err := writeJournalAt(h.txFD, next, true); err != nil {
		return Journal{}, err
	}
	return cloneJournal(next), nil
}

func sameStoreOwnedFields(left, right Journal) bool {
	return left.Revision == right.Revision && left.CreatedAt.Equal(right.CreatedAt) && left.UpdatedAt.Equal(right.UpdatedAt) &&
		reflect.DeepEqual(left.CompletedAt, right.CompletedAt) && reflect.DeepEqual(left.History, right.History)
}

func cloneJournal(j Journal) Journal {
	clone := j
	clone.History = append([]PhaseEvent(nil), j.History...)
	if j.Snapshot != nil {
		value := *j.Snapshot
		clone.Snapshot = &value
	}
	if j.Helper != nil {
		value := *j.Helper
		clone.Helper = &value
	}
	if j.TargetAck != nil {
		value := *j.TargetAck
		clone.TargetAck = &value
	}
	if j.TargetPlatformCommit != nil {
		value := *j.TargetPlatformCommit
		clone.TargetPlatformCommit = &value
	}
	if j.AbortCleanup != nil {
		value := *j.AbortCleanup
		clone.AbortCleanup = &value
	}
	if j.CompletedAt != nil {
		value := *j.CompletedAt
		clone.CompletedAt = &value
	}
	return clone
}

func readJournalAt(txFD int) (Journal, error) {
	file, _, err := openRegularAt(txFD, journalName, false, "handoff journal")
	if err != nil {
		return Journal{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return Journal{}, fmt.Errorf("inspect handoff journal: %w", err)
	}
	if info.Size() <= 0 || info.Size() > MaxJournalBytes {
		return Journal{}, errors.New("handoff journal size is invalid")
	}
	data, err := io.ReadAll(io.LimitReader(file, MaxJournalBytes+1))
	if err != nil {
		return Journal{}, fmt.Errorf("read handoff journal: %w", err)
	}
	journal, err := decodeJournal(data)
	if err != nil {
		return Journal{}, err
	}
	if err := Validate(journal); err != nil {
		return Journal{}, fmt.Errorf("validate handoff journal: %w", err)
	}
	return journal, nil
}

func writeJournalAt(txFD int, journal Journal, replacing bool) error {
	if err := Validate(journal); err != nil {
		return err
	}
	if replacing {
		existing, err := readJournalAt(txFD)
		if err != nil {
			return err
		}
		if existing.TransactionID != journal.TransactionID || existing.Revision+1 != journal.Revision {
			return ErrRevisionConflict
		}
	} else {
		if existing, _, err := openRegularAt(txFD, journalName, false, "handoff journal"); err == nil {
			_ = existing.Close()
			return errors.New("handoff journal already exists")
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if err := removeSafeTempAt(txFD); err != nil {
		return err
	}
	data, err := json.MarshalIndent(journal, "", "  ")
	if err != nil {
		return fmt.Errorf("encode handoff journal: %w", err)
	}
	data = append(data, '\n')
	if len(data) > MaxJournalBytes {
		return errors.New("encoded handoff journal exceeds its size limit")
	}
	temp, _, err := openRegularAt(txFD, journalTempName, true, "handoff journal temporary file")
	if err != nil {
		return err
	}
	removeTemp := true
	defer func() {
		_ = temp.Close()
		if removeTemp {
			_ = syscall.Unlinkat(txFD, journalTempName)
		}
	}()
	if _, err := temp.Write(data); err != nil {
		return fmt.Errorf("write handoff journal temporary file: %w", err)
	}
	if err := temp.Sync(); err != nil {
		return fmt.Errorf("sync handoff journal temporary file: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close handoff journal temporary file: %w", err)
	}
	if err := syscall.Renameat(txFD, journalTempName, txFD, journalName); err != nil {
		return fmt.Errorf("replace handoff journal: %w", err)
	}
	removeTemp = false
	if err := syscall.Fsync(txFD); err != nil {
		return fmt.Errorf("sync handoff transaction directory: %w", err)
	}
	return nil
}

func removeSafeTempAt(txFD int) error {
	file, _, err := openRegularAt(txFD, journalTempName, false, "handoff journal temporary file")
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	_ = file.Close()
	if err := syscall.Unlinkat(txFD, journalTempName); err != nil {
		return fmt.Errorf("remove stale handoff journal temporary file: %w", err)
	}
	return syscall.Fsync(txFD)
}

func decodeJournal(data []byte) (Journal, error) {
	if len(data) == 0 || len(data) > MaxJournalBytes {
		return Journal{}, errors.New("handoff journal JSON size is invalid")
	}
	if err := rejectDuplicateJSONFields(data); err != nil {
		return Journal{}, err
	}
	if err := validateExactJournalJSONFields(data); err != nil {
		return Journal{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var journal Journal
	if err := decoder.Decode(&journal); err != nil {
		return Journal{}, fmt.Errorf("decode handoff journal: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return Journal{}, errors.New("decode handoff journal: trailing JSON value")
		}
		return Journal{}, fmt.Errorf("decode handoff journal: %w", err)
	}
	return journal, nil
}

func validateExactJournalJSONFields(data []byte) error {
	var root map[string]json.RawMessage
	if err := json.Unmarshal(data, &root); err != nil {
		return fmt.Errorf("decode handoff journal field map: %w", err)
	}
	if err := requireExactFields("journal", root, []string{
		"schema_version", "revision", "transaction_id", "status", "desired_outcome", "phase", "binding_sha256",
		"release", "source", "target", "evidence", "snapshot", "helper", "target_ack", "target_platform_commit", "abort_cleanup",
		"history", "error", "created_at", "updated_at", "completed_at",
	}); err != nil {
		return err
	}
	objects := []struct {
		name     string
		raw      json.RawMessage
		optional bool
		fields   []string
	}{
		{"release", root["release"], false, []string{"predecessor_generation", "bridge_generation", "manifest_path", "manifest_sha256", "target_manager_sha256", "target_manager_version", "target_compose_sha256"}},
		{"source", root["source"], false, []string{"namespace", "unit", "unit_enabled", "unit_path", "unit_sha256", "stable_binary", "stable_sha256", "config_path", "config_sha256", "manifest_path", "manifest_sha256", "compose_path", "compose_sha256", "data_root", "socket_path", "compose_project", "core_network", "core_network_id", "label_prefix"}},
		{"target", root["target"], false, []string{"namespace", "unit", "unit_path", "stable_binary", "config_path", "config_sha256", "data_root", "socket_path", "compose_project", "core_network", "label_prefix"}},
		{"evidence", root["evidence"], false, []string{"manager_state_sha256", "self_update_state_sha256", "sandbox_registry_sha256", "docker_inventory_sha256", "database_schema_version", "database_integrity", "runtime_identity_sha256", "workspace_identity_sha256", "boot_id"}},
		{"snapshot", root["snapshot"], true, []string{"path", "manifest_sha256"}},
		{"helper", root["helper"], true, []string{"unit", "unit_sha256", "executable", "sha256", "argv_sha256", "control_group"}},
		{"target_ack", root["target_ack"], true, []string{"manager_version", "executable_sha256", "source_commit", "pid", "socket_path", "auto_update_check_at", "issued_at", "proof_sha256"}},
		{"target_platform_commit", root["target_platform_commit"], true, []string{"schema_version", "operation_id", "target_generation", "binding_sha256", "database_schema_version", "committed_at", "receipt_sha256"}},
		{"abort_cleanup", root["abort_cleanup"], true, []string{"reservation_released", "staging_removed", "listeners_restored", "source_identity_verified", "source_public_ready"}},
	}
	for _, object := range objects {
		if object.optional && bytes.Equal(bytes.TrimSpace(object.raw), []byte("null")) {
			continue
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(object.raw, &fields); err != nil || fields == nil {
			return fmt.Errorf("handoff journal %s must be an object", object.name)
		}
		if err := requireExactFields(object.name, fields, object.fields); err != nil {
			return err
		}
	}
	var history []json.RawMessage
	if err := json.Unmarshal(root["history"], &history); err != nil || history == nil {
		return errors.New("handoff journal history must be an array")
	}
	for index, raw := range history {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
			return fmt.Errorf("handoff history event %d must be an object", index)
		}
		if err := requireExactFields(fmt.Sprintf("history[%d]", index), fields, []string{"phase", "at", "note"}); err != nil {
			return err
		}
	}
	return nil
}

func requireExactFields(name string, observed map[string]json.RawMessage, expected []string) error {
	if len(observed) != len(expected) {
		return fmt.Errorf("handoff journal %s fields do not match schema 1", name)
	}
	for _, field := range expected {
		if _, ok := observed[field]; !ok {
			return fmt.Errorf("handoff journal %s is missing exact field %q", name, field)
		}
	}
	return nil
}

func rejectDuplicateJSONFields(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := scanJSONValue(decoder); err != nil {
		return fmt.Errorf("decode handoff journal: %w", err)
	}
	if token, err := decoder.Token(); err != io.EOF {
		if err == nil {
			return fmt.Errorf("unexpected trailing token %v", token)
		}
		return err
	}
	return nil
}

func scanJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delimiter {
	case '{':
		seen := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("JSON object key is not a string")
			}
			if _, exists := seen[key]; exists {
				return fmt.Errorf("duplicate JSON field %q", key)
			}
			seen[key] = struct{}{}
			if err := scanJSONValue(decoder); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim('}') {
			return errors.New("unterminated JSON object")
		}
	case '[':
		for decoder.More() {
			if err := scanJSONValue(decoder); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim(']') {
			return errors.New("unterminated JSON array")
		}
	default:
		return fmt.Errorf("unexpected JSON delimiter %q", delimiter)
	}
	return nil
}

func acquireLockAt(dirFD int, name, label string) (*os.File, error) {
	file, _, err := openRegularAt(dirFD, name, true, label+" lock")
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, fmt.Errorf("%w: %s lock is held", ErrBusy, label)
		}
		return nil, fmt.Errorf("acquire %s lock: %w", label, err)
	}
	if err := verifyRegularAt(dirFD, name, int(file.Fd()), label+" lock"); err != nil {
		releaseLock(file)
		return nil, err
	}
	return file, nil
}

func acquireExistingLockAt(dirFD int, name, label string) (*os.File, error) {
	file, _, err := openRegularAt(dirFD, name, false, label+" lock")
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, fmt.Errorf("%w: %s lock is held", ErrBusy, label)
		}
		return nil, fmt.Errorf("acquire %s lock: %w", label, err)
	}
	if err := verifyRegularAt(dirFD, name, int(file.Fd()), label+" lock"); err != nil {
		releaseLock(file)
		return nil, err
	}
	return file, nil
}

func releaseLock(file *os.File) {
	if file == nil {
		return
	}
	_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
	_ = file.Close()
}

func openRegularAt(dirFD int, name string, create bool, label string) (*os.File, bool, error) {
	flags := syscall.O_RDWR | syscall.O_CLOEXEC | syscall.O_NOFOLLOW
	created := false
	fd := -1
	var err error
	if create {
		fd, err = syscall.Openat(dirFD, name, flags|syscall.O_CREAT|syscall.O_EXCL, 0o600)
		if err == nil {
			created = true
			if chmodErr := syscall.Fchmod(fd, 0o600); chmodErr != nil {
				_ = syscall.Close(fd)
				_ = syscall.Unlinkat(dirFD, name)
				return nil, false, fmt.Errorf("set %s permissions: %w", label, chmodErr)
			}
		} else if errors.Is(err, syscall.EEXIST) {
			fd, err = syscall.Openat(dirFD, name, flags, 0)
		}
	} else {
		fd, err = syscall.Openat(dirFD, name, flags, 0)
	}
	if err != nil {
		if errors.Is(err, syscall.ENOENT) {
			return nil, false, os.ErrNotExist
		}
		if errors.Is(err, syscall.ELOOP) {
			return nil, false, fmt.Errorf("%w: %s is a symbolic link", ErrUnsafePath, label)
		}
		return nil, false, fmt.Errorf("open %s: %w", label, err)
	}
	file := os.NewFile(uintptr(fd), name)
	if file == nil {
		_ = syscall.Close(fd)
		return nil, false, fmt.Errorf("open %s: invalid file descriptor", label)
	}
	if err := verifyRegularAt(dirFD, name, fd, label); err != nil {
		_ = file.Close()
		if created {
			_ = syscall.Unlinkat(dirFD, name)
		}
		return nil, false, err
	}
	return file, created, nil
}

func verifyRegularAt(dirFD int, name string, fd int, label string) error {
	var opened, path syscall.Stat_t
	if err := syscall.Fstat(fd, &opened); err != nil {
		return fmt.Errorf("inspect opened %s: %w", label, err)
	}
	if err := fstatat(dirFD, name, &path, atSymlinkNoFollow); err != nil {
		return fmt.Errorf("inspect %s path: %w", label, err)
	}
	if opened.Dev != path.Dev || opened.Ino != path.Ino || opened.Mode&syscall.S_IFMT != syscall.S_IFREG ||
		path.Mode&syscall.S_IFMT != syscall.S_IFREG || opened.Uid != uint32(os.Getuid()) || opened.Nlink != 1 || opened.Mode&0o777 != 0o600 {
		return fmt.Errorf("%w: %s must be an owner-owned singly-linked 0600 regular file", ErrUnsafePath, label)
	}
	return nil
}

func openTransactionDir(rootFD int, transactionID string) (int, error) {
	if !transactionIDPattern.MatchString(transactionID) {
		return -1, errors.New("invalid handoff transaction id")
	}
	fd, err := syscall.Openat(rootFD, transactionID, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return -1, fmt.Errorf("open handoff transaction directory: %w", err)
	}
	if err := verifyDirectoryAt(rootFD, transactionID, fd, true); err != nil {
		_ = syscall.Close(fd)
		return -1, err
	}
	return fd, nil
}

func openNewTransactionDir(rootFD int, transactionID string) (int, error) {
	fd, err := syscall.Openat(rootFD, transactionID, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return -1, fmt.Errorf("open new handoff transaction directory: %w", err)
	}
	if err := syscall.Fchmod(fd, 0o700); err != nil {
		_ = syscall.Close(fd)
		return -1, fmt.Errorf("set handoff transaction directory permissions: %w", err)
	}
	if err := verifyDirectoryAt(rootFD, transactionID, fd, true); err != nil {
		_ = syscall.Close(fd)
		return -1, err
	}
	return fd, nil
}

func ensureDirectoryAt(parentFD int, parentPath, name string, exactMode bool) (int, error) {
	created := false
	if err := syscall.Mkdirat(parentFD, name, 0o700); err != nil {
		if !errors.Is(err, syscall.EEXIST) {
			return -1, err
		}
	} else {
		created = true
	}
	fd, err := syscall.Openat(parentFD, name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return -1, err
	}
	if created {
		if err := syscall.Fchmod(fd, 0o700); err != nil {
			_ = syscall.Close(fd)
			return -1, err
		}
	}
	if err := verifyDirectoryAt(parentFD, name, fd, exactMode); err != nil {
		_ = syscall.Close(fd)
		return -1, err
	}
	if err := syscall.Fsync(parentFD); err != nil {
		_ = syscall.Close(fd)
		return -1, fmt.Errorf("sync parent directory %s: %w", parentPath, err)
	}
	return fd, nil
}

func openDirectoryAt(parentFD int, name string, exactMode bool) (int, error) {
	fd, err := syscall.Openat(parentFD, name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return -1, err
	}
	if err := verifyDirectoryAt(parentFD, name, fd, exactMode); err != nil {
		_ = syscall.Close(fd)
		return -1, err
	}
	return fd, nil
}

func openOwnedDirectory(path string, exactMode bool) (int, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return -1, err
	}
	var opened syscall.Stat_t
	if err := syscall.Fstat(fd, &opened); err != nil {
		_ = syscall.Close(fd)
		return -1, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		_ = syscall.Close(fd)
		return -1, err
	}
	observed, ok := info.Sys().(*syscall.Stat_t)
	unsafeMode := opened.Mode&0o022 != 0
	if exactMode {
		unsafeMode = opened.Mode&0o777 != 0o700
	}
	if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || observed.Dev != opened.Dev || observed.Ino != opened.Ino ||
		opened.Uid != uint32(os.Getuid()) || unsafeMode {
		_ = syscall.Close(fd)
		return -1, errors.New("directory owner, type, link, or permissions are unsafe")
	}
	return fd, nil
}

func verifyDirectoryAt(parentFD int, name string, fd int, exactMode bool) error {
	var opened, path syscall.Stat_t
	if err := syscall.Fstat(fd, &opened); err != nil {
		return err
	}
	if err := fstatat(parentFD, name, &path, atSymlinkNoFollow); err != nil {
		return err
	}
	unsafeMode := opened.Mode&0o022 != 0
	if exactMode {
		unsafeMode = opened.Mode&0o777 != 0o700
	}
	if opened.Dev != path.Dev || opened.Ino != path.Ino || opened.Mode&syscall.S_IFMT != syscall.S_IFDIR ||
		path.Mode&syscall.S_IFMT != syscall.S_IFDIR || opened.Uid != uint32(os.Getuid()) || unsafeMode {
		return fmt.Errorf("%w: directory %q has unsafe owner, type, or permissions", ErrUnsafePath, name)
	}
	return nil
}

func readDirectory(fd int) ([]os.DirEntry, error) {
	// dup(2) shares the directory stream offset with its source descriptor.
	// Open "." relative to the verified directory instead so every strict
	// enumeration starts at the beginning.
	duplicate, err := syscall.Openat(fd, ".", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(duplicate), "handoff-directory")
	if file == nil {
		_ = syscall.Close(duplicate)
		return nil, errors.New("invalid handoff directory descriptor")
	}
	defer file.Close()
	return file.ReadDir(-1)
}

func fstatat(dirFD int, name string, stat *syscall.Stat_t, flags int) error {
	pointer, err := syscall.BytePtrFromString(name)
	if err != nil {
		return err
	}
	_, _, errno := syscall.Syscall6(handoffFstatatSyscall, uintptr(dirFD), uintptr(unsafe.Pointer(pointer)), uintptr(unsafe.Pointer(stat)), uintptr(flags), 0, 0)
	if errno != 0 {
		return errno
	}
	return nil
}

func unlinkat(dirFD int, name string, flags int) error {
	pointer, err := syscall.BytePtrFromString(name)
	if err != nil {
		return err
	}
	_, _, errno := syscall.Syscall(syscall.SYS_UNLINKAT, uintptr(dirFD), uintptr(unsafe.Pointer(pointer)), uintptr(flags))
	if errno != 0 {
		return errno
	}
	return nil
}

func pathContains(parent, child string) bool {
	relative, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}
	return relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)))
}

func rejectSymlinkComponents(path string) error {
	current := string(filepath.Separator)
	for _, component := range strings.Split(strings.TrimPrefix(path, string(filepath.Separator)), string(filepath.Separator)) {
		if component == "" {
			continue
		}
		current = filepath.Join(current, component)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("inspect path component %s: %w", current, err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("path component %s is a symbolic link", current)
		}
	}
	return nil
}

func validateDataRoot(path string, mustExist bool) error {
	current := path
	for {
		info, err := os.Lstat(current)
		if err == nil {
			stat, ok := info.Sys().(*syscall.Stat_t)
			if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || stat.Uid != uint32(os.Getuid()) || info.Mode().Perm()&0o022 != 0 {
				return fmt.Errorf("%s or its nearest parent is not an owner-controlled directory", current)
			}
			if mustExist && current != path {
				return fmt.Errorf("required data root %s does not exist", path)
			}
			return nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		parent := filepath.Dir(current)
		if parent == current {
			return errors.New("no existing owner-controlled parent")
		}
		current = parent
	}
}

func rejectPhysicalContainment(paths ...string) error {
	for left := range paths {
		leftStat, leftExists, err := statExistingDirectory(paths[left])
		if err != nil {
			return err
		}
		if !leftExists {
			continue
		}
		for right := range paths {
			if left == right {
				continue
			}
			current := paths[right]
			for {
				rightStat, exists, err := statExistingDirectory(current)
				if err != nil {
					return err
				}
				if exists && leftStat.Dev == rightStat.Dev && leftStat.Ino == rightStat.Ino {
					return fmt.Errorf("physical path identity %s contains or aliases %s", paths[left], paths[right])
				}
				parent := filepath.Dir(current)
				if parent == current {
					break
				}
				current = parent
			}
		}
	}
	return nil
}

func statExistingDirectory(path string) (syscall.Stat_t, bool, error) {
	var stat syscall.Stat_t
	err := syscall.Lstat(path, &stat)
	if errors.Is(err, syscall.ENOENT) {
		return stat, false, nil
	}
	if err != nil {
		return stat, false, err
	}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFDIR {
		return stat, false, fmt.Errorf("path %s is not a directory", path)
	}
	return stat, true, nil
}
