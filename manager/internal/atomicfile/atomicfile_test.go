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
