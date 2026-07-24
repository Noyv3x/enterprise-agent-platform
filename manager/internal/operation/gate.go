package operation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Reservation struct {
	Ready             bool   `json:"ready"`
	Reserved          bool   `json:"reserved"`
	Reason            string `json:"reason,omitempty"`
	RetryAfterSeconds int    `json:"retry_after_seconds,omitempty"`
}
type Gate interface {
	Reserve(context.Context, string) (Reservation, error)
	Release(context.Context, string) error
	Health(context.Context) error
}

type HTTPGate struct {
	BaseURL, Token string
	Client         *http.Client
}

func (g HTTPGate) Reserve(ctx context.Context, id string) (Reservation, error) {
	var result Reservation
	err := g.call(ctx, http.MethodPost, "/internal/manager/update/readiness", map[string]string{"operation_id": id}, &result)
	return result, err
}
func (g HTTPGate) Release(ctx context.Context, id string) error {
	return g.call(ctx, http.MethodPost, "/internal/manager/update/release", map[string]string{"operation_id": id}, nil)
}
func (g HTTPGate) Health(ctx context.Context) error {
	return g.call(ctx, http.MethodGet, "/internal/manager/health", nil, nil)
}
func (g HTTPGate) call(ctx context.Context, method, path string, body any, result any) error {
	if g.BaseURL == "" {
		return errors.New("platform gate URL is not configured")
	}
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(g.BaseURL, "/")+path, reader)
	if err != nil {
		return err
	}
	if g.Token != "" {
		req.Header.Set("Authorization", "Bearer "+g.Token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := g.Client
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	response, err := client.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return fmt.Errorf("platform gate HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(data)))
	}
	if result == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return nil
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 1<<20))
	if err := decoder.Decode(result); err != nil {
		return fmt.Errorf("decode platform gate response: %w", err)
	}
	return nil
}
