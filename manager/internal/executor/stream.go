package executor

import (
	"context"
	"sync"
	"unicode/utf8"
)

const (
	// A streaming response carries at most this many output bytes per call. The
	// final result remains authoritative for everything beyond it.
	streamOutputLimit = 1 << 20
	// Committed output waiting for the HTTP reader is coalesced in memory. A
	// reader that falls further behind than this stops receiving output frames
	// (a consistent prefix); the command itself is never slowed or failed.
	streamPendingLimit = 256 << 10
	streamFrameBytes   = 64 << 10
)

// OutputFrame is one NDJSON output line of a streaming terminal response.
type OutputFrame struct {
	Type   string `json:"type"`
	Stream string `json:"stream"`
	Data   string `json:"data"`
}

type outputSegment struct {
	stream string
	data   []byte
}

// liveOutput collects already-redacted, committed output for a streaming
// response. append never blocks, so a slow HTTP reader cannot stall the command
// or its redaction path. Memory is bounded by streamPendingLimit.
type liveOutput struct {
	mu       sync.Mutex
	segments []outputSegment
	pending  int
	accepted int
	stopped  bool
	closed   bool
	carry    map[string][]byte // incomplete trailing UTF-8 per stream
	wake     chan struct{}
}

func newLiveOutput() *liveOutput {
	return &liveOutput{carry: map[string][]byte{}, wake: make(chan struct{}, 1)}
}

func (l *liveOutput) signalLocked() {
	select {
	case l.wake <- struct{}{}:
	default:
	}
}

func incompleteTail(p []byte) int {
	for back := 1; back <= min(len(p), utf8.UTFMax-1); back++ {
		if utf8.RuneStart(p[len(p)-back]) {
			if !utf8.FullRune(p[len(p)-back:]) {
				return back
			}
			return 0
		}
	}
	return 0
}

func (l *liveOutput) append(stream string, p []byte) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.stopped || l.closed || len(p) == 0 {
		return
	}
	data := append(append([]byte(nil), l.carry[stream]...), p...)
	tail := incompleteTail(data)
	l.carry[stream] = append(l.carry[stream][:0], data[len(data)-tail:]...)
	data = data[:len(data)-tail]
	if room := streamOutputLimit - l.accepted; len(data) >= room {
		cut := room
		for cut > 0 && cut < len(data) && !utf8.RuneStart(data[cut]) {
			cut--
		}
		data = data[:cut]
		l.stopped = true
	}
	if l.pending+len(data) > streamPendingLimit {
		l.stopped = true
		l.signalLocked()
		return
	}
	if len(data) > 0 {
		l.accepted += len(data)
		l.pending += len(data)
		if n := len(l.segments); n > 0 && l.segments[n-1].stream == stream {
			l.segments[n-1].data = append(l.segments[n-1].data, data...)
		} else {
			l.segments = append(l.segments, outputSegment{stream: stream, data: data})
		}
	}
	l.signalLocked()
}

// close publishes any remaining incomplete rune bytes and ends the stream.
func (l *liveOutput) close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.stopped {
		for _, stream := range []string{"stdout", "stderr"} {
			if rest := l.carry[stream]; len(rest) > 0 && l.pending+len(rest) <= streamPendingLimit && l.accepted+len(rest) <= streamOutputLimit {
				l.segments = append(l.segments, outputSegment{stream: stream, data: append([]byte(nil), rest...)})
				l.pending += len(rest)
				l.accepted += len(rest)
			}
		}
	}
	l.closed = true
	l.signalLocked()
}

func (l *liveOutput) take() (segments []outputSegment, closed bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	segments, l.segments, l.pending = l.segments, nil, 0
	return segments, l.closed
}

// drain forwards coalesced output as frames until the stream is closed and
// empty. After emit fails it keeps consuming without emitting so producers are
// never held back.
func (l *liveOutput) drain(emit func(any) error) {
	failed := false
	for {
		<-l.wake
		segments, closed := l.take()
		for _, segment := range segments {
			for data := segment.data; len(data) > 0 && !failed; {
				n := min(len(data), streamFrameBytes)
				for n < len(data) && n > 0 && !utf8.RuneStart(data[n]) {
					n--
				}
				if n == 0 {
					n = min(len(data), streamFrameBytes)
				}
				if emit(OutputFrame{Type: "output", Stream: segment.stream, Data: string(data[:n])}) != nil {
					failed = true
				}
				data = data[n:]
			}
		}
		if closed {
			// close() signals after setting closed; one more take is not needed
			// because append is a no-op once closed.
			return
		}
	}
}

// TerminalStream runs Terminal like Service.Terminal and additionally calls
// emit with output frames as sanitized output is committed. emit is invoked
// from one goroutine at a time and never concurrently with the caller after
// TerminalStream returns. Private output is never emitted.
func (s *Service) TerminalStream(ctx context.Context, call Call, emit func(any) error) (map[string]any, error) {
	live := newLiveOutput()
	done := make(chan struct{})
	go func() {
		defer close(done)
		live.drain(emit)
	}()
	result, err := s.terminal(ctx, call, live)
	live.close()
	<-done
	return result, err
}
