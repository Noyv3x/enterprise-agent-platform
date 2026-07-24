package logstore

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

type Store struct {
	path     string
	maxBytes int64
	backups  int
	mu       sync.Mutex
}

func New(path string, maxBytes int64, backups int) *Store {
	if maxBytes < 1024 {
		maxBytes = 10 << 20
	}
	if backups < 1 {
		backups = 5
	}
	return &Store{path: path, maxBytes: maxBytes, backups: backups}
}

func (s *Store) Append(event any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	if info, err := os.Stat(s.path); err == nil && info.Size()+int64(len(data)) > s.maxBytes {
		if err := s.rotateLocked(); err != nil {
			return err
		}
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}
	f, err := os.OpenFile(s.path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

func (s *Store) Tail(lines int) ([]json.RawMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if lines < 1 {
		lines = 100
	}
	if lines > 1000 {
		lines = 1000
	}
	f, err := os.Open(s.path)
	if os.IsNotExist(err) {
		return []json.RawMessage{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	all := make([]json.RawMessage, 0, lines)
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 2<<20)
	for scanner.Scan() {
		value := append(json.RawMessage(nil), scanner.Bytes()...)
		if json.Valid(value) {
			all = append(all, value)
			if len(all) > lines {
				all = all[1:]
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return all, nil
}

func (s *Store) rotateLocked() error {
	for i := s.backups; i >= 1; i-- {
		from := s.path + "." + strconv.Itoa(i)
		to := s.path + "." + strconv.Itoa(i+1)
		if i == s.backups {
			if err := os.Remove(from); err != nil && !os.IsNotExist(err) {
				return err
			}
			continue
		}
		if err := os.Rename(from, to); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if err := os.Rename(s.path, s.path+".1"); err != nil && !os.IsNotExist(err) {
		return err
	}
	return syncDirectory(filepath.Dir(s.path))
}

func syncDirectory(path string) error {
	d, err := os.Open(path)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

type Event struct {
	At          time.Time `json:"at"`
	Type        string    `json:"type"`
	OperationID string    `json:"operation_id,omitempty"`
	AuditID     string    `json:"audit_id,omitempty"`
	ExecutorID  string    `json:"executor_id,omitempty"`
	Target      string    `json:"target,omitempty"`
	RunID       string    `json:"run_id,omitempty"`
	ScopeID     string    `json:"scope_id,omitempty"`
	ToolCallID  string    `json:"tool_call_id,omitempty"`
	Details     any       `json:"details,omitempty"`
	Result      any       `json:"result,omitempty"`
	Error       string    `json:"error,omitempty"`
}

func ValidateLogPermissions(path string) error {
	info, err := os.Stat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("%s must be owner-only", path)
	}
	if !info.Mode().IsRegular() {
		return errors.New("log path is not a regular file")
	}
	return nil
}
