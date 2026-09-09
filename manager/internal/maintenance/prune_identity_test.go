package maintenance

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPrunePreservesChangedReleaseEvidence(t *testing.T) {
	for _, staging := range []bool{false, true} {
		kind := "release"
		if staging {
			kind = "staging"
		}
		t.Run(kind, func(t *testing.T) {
			for _, change := range []string{"unchanged", "replacement", "unknown-entry", "rewritten-file", "hard-link"} {
				t.Run(change, func(t *testing.T) {
					root := t.TempDir()
					releases := filepath.Join(root, "releases")
					if err := os.Mkdir(releases, 0o700); err != nil {
						t.Fatal(err)
					}
					now := time.Unix(20000, 0)
					id := strings.Repeat("a", 40)
					var path string
					if staging {
						path = filepath.Join(releases, ".release-"+id+"-123456789")
						if err := os.Mkdir(path, 0o700); err != nil {
							t.Fatal(err)
						}
						if err := os.WriteFile(filepath.Join(path, "manifest.json"), []byte("partial evidence"), 0o600); err != nil {
							t.Fatal(err)
						}
						if err := os.Chtimes(path, now.Add(-2*time.Hour), now.Add(-2*time.Hour)); err != nil {
							t.Fatal(err)
						}
					} else {
						path = writeRelease(t, releases, id, now.Add(-2*time.Hour), "a")
					}
					original, err := os.ReadFile(filepath.Join(path, "manifest.json"))
					if err != nil {
						t.Fatal(err)
					}
					moved := filepath.Join(root, "retained-original")
					called := false
					guard := func() (func(), bool) {
						called = true
						switch change {
						case "replacement":
							if err := os.Rename(path, moved); err != nil {
								t.Fatal(err)
							}
							if err := os.Mkdir(path, 0o700); err != nil {
								t.Fatal(err)
							}
							fallthrough
						case "unknown-entry":
							if err := os.WriteFile(filepath.Join(path, "operator-note.txt"), []byte("new evidence"), 0o600); err != nil {
								t.Fatal(err)
							}
						case "rewritten-file":
							file := filepath.Join(path, "manifest.json")
							info, err := os.Stat(file)
							if err != nil {
								t.Fatal(err)
							}
							// Even identical bytes with restored mtime are a new version.
							if err := os.WriteFile(file, original, 0o600); err != nil {
								t.Fatal(err)
							}
							if err := os.Chtimes(file, info.ModTime(), info.ModTime()); err != nil {
								t.Fatal(err)
							}
						case "hard-link":
							if err := os.Link(filepath.Join(path, "manifest.json"), filepath.Join(root, "linked-evidence")); err != nil {
								t.Fatal(err)
							}
						}
						return func() {}, true
					}
					removed, err := PruneReleases(context.Background(), now, ReleasePolicy{
						Root: releases, Channel: "main", Retention: time.Hour,
						Images: &recordingImagePruner{}, RemovalGuard: guard,
					})
					if !called {
						t.Fatalf("candidate never reached admission: %v", err)
					}
					if change == "unchanged" {
						if err != nil || removed != 1 {
							t.Fatalf("valid candidate not removed: count=%d err=%v", removed, err)
						}
						if _, err := os.Lstat(path); !os.IsNotExist(err) {
							t.Fatalf("candidate remains: %v", err)
						}
						return
					}
					if removed != 0 || err == nil {
						t.Fatalf("changed evidence not reported as retained: count=%d err=%v", removed, err)
					}
					evidence := path
					if change == "replacement" {
						evidence = moved
					}
					if got, err := os.ReadFile(filepath.Join(evidence, "manifest.json")); err != nil || string(got) != string(original) {
						t.Errorf("original evidence changed: %q %v", got, err)
					}
					if change == "replacement" || change == "unknown-entry" {
						if got, err := os.ReadFile(filepath.Join(path, "operator-note.txt")); err != nil || string(got) != "new evidence" {
							t.Errorf("new evidence changed: %q %v", got, err)
						}
					}
				})
			}
		})
	}
}
