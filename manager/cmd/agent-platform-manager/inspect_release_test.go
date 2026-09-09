package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/releasetest"
)

func TestInspectReleaseValidatesEntireCatalogBeforeOutput(t *testing.T) {
	fixture := releasetest.NewTarget(strings.Repeat("a", 40))
	valid, err := json.Marshal(fixture.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	other := fixture.Manifest.Manager.Artifacts["arm64"]
	other.SHA256 = "invalid"
	fixture.Manifest.Manager.Artifacts["arm64"] = other
	invalidOther, err := json.Marshal(fixture.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name  string
		data  []byte
		valid bool
	}{
		{"valid", valid, true},
		{"other architecture", invalidOther, false},
		{"unknown field", append([]byte(`{"unexpected":true,`), valid[1:]...), false},
		{"duplicate field", append([]byte(`{"schema_version":2,`), valid[1:]...), false},
		{"wrong type", bytes.Replace(valid, []byte(`"schema_version":2`), []byte(`"schema_version":"2"`), 1), false},
		{"oversized", append(append([]byte{}, valid...), bytes.Repeat([]byte(" "), 1<<20)...), false},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			manifestPath := filepath.Join(root, "release.json")
			if err := os.WriteFile(manifestPath, test.data, 0600); err != nil {
				t.Fatal(err)
			}
			var output bytes.Buffer
			err := inspectReleaseCommand([]string{"--manifest", manifestPath, "--architecture", "amd64"}, &output)
			if test.valid {
				artifact := fixture.Manifest.Manager.Artifacts["amd64"]
				if err != nil || output.String() != artifact.URL+"\n"+artifact.SHA256+"\n" {
					t.Fatalf("inspection: output %q, error %v", output.String(), err)
				}
			} else if err == nil || output.Len() != 0 {
				t.Fatalf("invalid catalog produced output %q, error %v", output.String(), err)
			}
		})
	}
}
