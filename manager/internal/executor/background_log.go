package executor

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/atomicfile"
)

const (
	processLogCapBytes  = 8 << 20
	processLogDropBytes = 4 << 20
	// A quiet process is shown after this idle gap even if the redactor still
	// holds an undecided suffix (see outputRedactor.Settle).
	processLogSettleDelay = 250 * time.Millisecond
)

// processLog is the capped, redacted, valid-UTF-8 output stream of one
// background process. Offsets are positions in the logical stream; the file
// holds [retainedFrom, retainedFrom+size). Rotation drops the oldest bytes at a
// rune boundary and records the new start in output.from.
type processLog struct {
	dir  string
	cap  int64
	drop int64

	mu           sync.Mutex
	file         *os.File
	retainedFrom int64
	size         int64
	carry        []byte // incomplete trailing rune awaiting its continuation
	redactor     outputRedactor
	wake         chan struct{}
	settleDelay  time.Duration
	settleTimer  *time.Timer
	closed       bool
}

func newProcessLog(dir string, capBytes, dropBytes int64) (*processLog, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	l := &processLog{dir: dir, cap: capBytes, drop: dropBytes, wake: make(chan struct{}), settleDelay: processLogSettleDelay}
	if err := atomicfile.ReadJSON(l.fromPath(), &l.retainedFrom); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	info, err := os.Stat(l.logPath())
	if err == nil {
		l.size = info.Size()
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	return l, nil
}

func (l *processLog) logPath() string  { return filepath.Join(l.dir, "output.log") }
func (l *processLog) fromPath() string { return filepath.Join(l.dir, "output.from") }

func (l *processLog) openLocked() error {
	if l.file != nil {
		return nil
	}
	file, err := os.OpenFile(l.logPath(), os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	l.file = file
	return nil
}

// Write redacts incrementally (a secret split across chunks is still caught)
// and appends the committed bytes.
func (l *processLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return len(p), nil
	}
	l.redactor.Write(p, l.sinkLocked)
	if l.settleTimer == nil {
		l.settleTimer = time.AfterFunc(l.settleDelay, l.settle)
	} else {
		l.settleTimer.Reset(l.settleDelay)
	}
	return len(p), nil
}

func (l *processLog) settle() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.closed {
		l.redactor.Settle(l.sinkLocked)
	}
}

// Close flushes the undecided redaction suffix and the incomplete rune, then
// releases the file descriptor. Reads keep working afterwards.
func (l *processLog) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.settleTimer != nil {
		l.settleTimer.Stop()
	}
	l.redactor.Flush(l.sinkLocked)
	l.closed = true
	l.appendLocked(nil, true)
	if l.file != nil {
		_ = l.file.Close()
		l.file = nil
	}
	l.signalLocked()
}

// Signal wakes long-polling readers, e.g. after a state change.
func (l *processLog) Signal() {
	l.mu.Lock()
	l.signalLocked()
	l.mu.Unlock()
}

func (l *processLog) signalLocked() {
	close(l.wake)
	l.wake = make(chan struct{})
}

func (l *processLog) WakeChan() <-chan struct{} {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.wake
}

func (l *processLog) Total() int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.retainedFrom + l.size
}

func (l *processLog) sinkLocked(p []byte) { l.appendLocked(p, false) }

func (l *processLog) appendLocked(p []byte, final bool) {
	data := p
	if len(l.carry) > 0 {
		data = append(append([]byte(nil), l.carry...), p...)
		l.carry = nil
	}
	if len(data) == 0 {
		return
	}
	out := make([]byte, 0, len(data))
	for len(data) > 0 {
		r, n := utf8.DecodeRune(data)
		if r == utf8.RuneError && n <= 1 {
			if !final && !utf8.FullRune(data) {
				l.carry = append([]byte(nil), data...)
				break
			}
			out = append(out, "\uFFFD"...)
			data = data[1:]
			continue
		}
		out = append(out, data[:n]...)
		data = data[n:]
	}
	if len(out) == 0 {
		return
	}
	if err := l.openLocked(); err != nil {
		return
	}
	if n, err := l.file.Write(out); err != nil {
		// A short write leaves a prefix; account only for what landed.
		l.size += int64(n)
		return
	}
	l.size += int64(len(out))
	if l.size > l.cap {
		_ = l.rotateLocked()
	}
	l.signalLocked()
}

func isContinuation(b byte) bool { return b&0xC0 == 0x80 }

func (l *processLog) rotateLocked() error {
	dropped := min(l.drop, l.size)
	var probe [4]byte
	n, _ := l.file.ReadAt(probe[:], dropped)
	for i := 0; i < n && isContinuation(probe[i]); i++ {
		dropped++
	}
	temporary := l.logPath() + ".rotate"
	next, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(next, io.NewSectionReader(l.file, dropped, l.size-dropped))
	closeErr := next.Close()
	if err := errors.Join(copyErr, closeErr); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	if err := os.Rename(temporary, l.logPath()); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	_ = l.file.Close()
	l.file = nil
	l.retainedFrom += dropped
	l.size -= dropped
	// Offsets after a crash between rename and this write are shifted by one
	// drop for an already-ended process; the log itself is never corrupted.
	return atomicfile.WriteJSON(l.fromPath(), l.retainedFrom, 0o600)
}

type logRead struct {
	Data         []byte
	Start        int64
	Next         int64
	RetainedFrom int64
	Total        int64
}

// Read returns up to max bytes of whole runes. offset -1 selects the tail.
func (l *processLog) Read(offset int64, max int) (logRead, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	total := l.retainedFrom + l.size
	start := offset
	if offset < 0 {
		start = total - int64(max)
	}
	start = min(max64(start, l.retainedFrom), total)
	result := logRead{Start: start, Next: start, RetainedFrom: l.retainedFrom, Total: total}
	if start >= total {
		return result, nil
	}
	file := l.file
	if file == nil {
		reader, err := os.Open(l.logPath())
		if err != nil {
			return result, err
		}
		defer reader.Close()
		file = reader
	}
	want := min(int64(max)+3, total-start)
	buffer := make([]byte, want)
	n, err := file.ReadAt(buffer, start-l.retainedFrom)
	if err != nil && !errors.Is(err, io.EOF) {
		return result, err
	}
	buffer = buffer[:n]
	for len(buffer) > 0 && isContinuation(buffer[0]) && result.Start < start+3 {
		buffer = buffer[1:]
		result.Start++
	}
	cut := len(buffer)
	if cut > max {
		cut = max
		for cut > 0 && isContinuation(buffer[cut]) {
			cut--
		}
		if cut == 0 {
			// A rune wider than max: return it whole rather than nothing.
			cut = 1
			for cut < len(buffer) && isContinuation(buffer[cut]) {
				cut++
			}
		}
	}
	result.Data = buffer[:cut]
	result.Next = result.Start + int64(cut)
	return result, nil
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
