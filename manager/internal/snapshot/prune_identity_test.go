package snapshot

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPrunePreservesChangedSnapshotEvidence(t *testing.T) {
	for _, staging := range []bool{false, true} {
		kind := "snapshot"
		if staging {
			kind = "staging"
		}
		t.Run(kind, func(t *testing.T) {
			for _, change := range []string{"unchanged", "replacement", "unknown-entry", "rewritten-file", "hard-link"} {
				t.Run(change, func(t *testing.T) {
					root := t.TempDir()
					data, backups := filepath.Join(root, "data"), filepath.Join(root, "backups")
					for _, dir := range []string{data, backups} {
						if err := os.Mkdir(dir, 0o700); err != nil {
							t.Fatal(err)
						}
					}
					writeFiles(t, data, map[string]string{"platform.db": "original evidence"})
					store := Store{DataDir: data, BackupDir: backups, Retention: time.Hour, StagingRetention: time.Hour}
					now := time.Unix(20000, 0)
					var path string
					if staging {
						var err error
						path, err = os.MkdirTemp(backups, ".snapshot-"+base64.RawURLEncoding.EncodeToString([]byte("op_identity"))+".*")
						if err != nil {
							t.Fatal(err)
						}
						writeFiles(t, path, map[string]string{"platform.db": "original evidence"})
						if err := os.Chtimes(path, now.Add(-2*time.Hour), now.Add(-2*time.Hour)); err != nil {
							t.Fatal(err)
						}
					} else {
						path = createSnapshotAt(t, store, "op_identity", now.Add(-2*time.Hour))
					}
					moved := filepath.Join(root, "retained-original")
					called := false
					store.RemovalGuard = func() (func(), bool) {
						called = true
						switch change {
						case "replacement":
							if err := os.Rename(path, moved); err != nil {
								t.Fatal(err)
							}
							if err := os.Mkdir(path, 0o700); err != nil {
								t.Fatal(err)
							}
							writeFiles(t, path, map[string]string{"operator-note.txt": "new evidence"})
						case "unknown-entry":
							writeFiles(t, path, map[string]string{"operator-note.txt": "new evidence"})
						case "rewritten-file":
							file := filepath.Join(path, "platform.db")
							info, err := os.Stat(file)
							if err != nil {
								t.Fatal(err)
							}
							writeFiles(t, path, map[string]string{"platform.db": "modified evidence"})
							if err := os.Chtimes(file, info.ModTime(), info.ModTime()); err != nil {
								t.Fatal(err)
							}
						case "hard-link":
							if err := os.Link(filepath.Join(path, "platform.db"), filepath.Join(root, "linked-evidence")); err != nil {
								t.Fatal(err)
							}
						}
						return func() {}, true
					}
					removed, err := store.Prune(context.Background(), now, nil)
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
					if change == "replacement" {
						assertFiles(t, moved, map[string]string{"platform.db": "original evidence"})
						assertFiles(t, path, map[string]string{"operator-note.txt": "new evidence"})
					} else {
						content := "original evidence"
						if change == "rewritten-file" {
							content = "modified evidence"
						}
						assertFiles(t, path, map[string]string{"platform.db": content})
						if change == "unknown-entry" {
							assertFiles(t, path, map[string]string{"operator-note.txt": "new evidence"})
						}
					}
				})
			}
		})
	}
}
