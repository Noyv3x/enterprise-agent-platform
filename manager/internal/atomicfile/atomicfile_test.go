package atomicfile

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadJSONReportsOversizedStateExplicitly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(path, bytes.Repeat([]byte("x"), int(maxJSONBytes)+1), 0o600); err != nil {
		t.Fatal(err)
	}
	var value any
	err := ReadJSON(path, &value)
	if err == nil || !strings.Contains(err.Error(), "JSON exceeds") {
		t.Fatalf("oversized state error = %v, want explicit size failure", err)
	}
}

func TestReadJSONStillRejectsTrailingValue(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(path, []byte("{}\n{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var value any
	err := ReadJSON(path, &value)
	if err == nil || !strings.Contains(err.Error(), "trailing JSON value") {
		t.Fatalf("trailing state error = %v", err)
	}
}

func TestReadJSONWithLimitStreamsLargerDomainArtifact(t *testing.T) {
	path := filepath.Join(t.TempDir(), "manifest.json")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString("{\"ok\":true}\n"); err != nil {
		t.Fatal(err)
	}
	padding := bytes.Repeat([]byte(" "), 1<<20)
	for range 9 {
		if _, err := file.Write(padding); err != nil {
			t.Fatal(err)
		}
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	var value struct {
		OK bool `json:"ok"`
	}
	if err := ReadJSON(path, &value); err == nil || !strings.Contains(err.Error(), "JSON exceeds") {
		t.Fatalf("small state budget accepted large domain artifact: %v", err)
	}
	if err := ReadJSONWithLimit(path, &value, 16<<20); err != nil {
		t.Fatalf("domain-specific streaming read failed: %v", err)
	}
	if !value.OK {
		t.Fatal("decoded domain artifact lost its value")
	}
}
