package executor

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"
)

// controlPipe is Manager's write end of an in-sandbox supervisor's stdin: the
// lifetime lease and the framed control channel. Closing it is EOF for the
// supervisor, which then kills its process group.
type controlPipe struct {
	mu     sync.Mutex
	file   *os.File
	closed bool
	broken bool
}

// send writes framed control lines. A write that cannot finish poisons the
// channel (a partial frame would corrupt the framing); a hard kill still works
// because it closes the lease instead.
func (c *controlPipe) send(frames ...map[string]any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.broken {
		return errors.New("process control channel is closed")
	}
	for _, frame := range frames {
		line, err := json.Marshal(frame)
		if err != nil {
			return err
		}
		_ = c.file.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if _, err := c.file.Write(append(line, '\n')); err != nil {
			c.broken = true
			return fmt.Errorf("process control channel failed: %w", err)
		}
	}
	return nil
}

func (c *controlPipe) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.closed {
		c.closed = true
		_ = c.file.Close()
	}
}
