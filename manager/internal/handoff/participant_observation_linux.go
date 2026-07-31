//go:build linux

package handoff

import (
	"errors"
	"fmt"
	"path/filepath"
	"syscall"
)

// ReadParticipantJournal returns one identity-bound, read-only journal
// snapshot without acquiring the global writer lease. It exists solely for a
// capability-routed participant while the persistent helper owns that lease.
// The immutable binding and minimum startup revision prevent this observation
// path from becoming a profile selector or a stale-transaction escape hatch.
func ReadParticipantJournal(transactionDirectory, transactionID, bindingSHA256 string, minimumRevision uint64) (Journal, error) {
	if !canonicalAbsolutePath(transactionDirectory) || filepath.Base(transactionDirectory) != transactionID ||
		!transactionIDPattern.MatchString(transactionID) || !sha256Pattern.MatchString(bindingSHA256) || minimumRevision == 0 {
		return Journal{}, errors.New("participant journal observation binding is invalid")
	}
	root := filepath.Dir(transactionDirectory)
	if filepath.Base(root) != "handoff" || filepath.Base(filepath.Dir(root)) != "agent-platform" {
		return Journal{}, errors.New("participant journal is outside the canonical handoff root")
	}
	rootFD, err := openOwnedDirectory(root, false)
	if err != nil {
		return Journal{}, fmt.Errorf("open participant handoff root: %w", err)
	}
	defer syscall.Close(rootFD)
	txFD, err := openTransactionDir(rootFD, transactionID)
	if err != nil {
		return Journal{}, fmt.Errorf("open participant transaction: %w", err)
	}
	defer syscall.Close(txFD)
	journal, err := readJournalAt(txFD)
	if err != nil {
		return Journal{}, fmt.Errorf("read participant journal: %w", err)
	}
	if journal.TransactionID != transactionID || journal.BindingSHA256 != bindingSHA256 || journal.Revision < minimumRevision {
		return Journal{}, errors.New("participant journal differs from the consumed startup capability")
	}
	return journal, nil
}
