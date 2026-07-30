package atomicfile

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestIsManagedTempNameIsExact(t *testing.T) {
	for _, name := range []string{".tmp-0", ".tmp-1234567890"} {
		if !IsManagedTempName(name) {
			t.Fatalf("IsManagedTempName(%q) = false, want true", name)
		}
	}
	for _, name := range []string{
		".tmp-", ".tmp-12345678901", ".tmp-123.json", ".tmp-a123", "x.tmp-123", ".tmp-12/3",
	} {
		if IsManagedTempName(name) {
			t.Fatalf("IsManagedTempName(%q) = true, want false", name)
		}
	}
}

func TestCleanupManagedTempsRemovesCrashLeftResidue(t *testing.T) {
	directoryPath := t.TempDir()
	command := exec.Command(os.Args[0], "-test.run=^TestCleanupManagedTempsCrashWriterHelper$")
	command.Env = append(os.Environ(), "UBITECH_ATOMIC_CRASH_HELPER=1", "UBITECH_ATOMIC_CRASH_DIR="+directoryPath)
	if err := command.Run(); err == nil {
		t.Fatal("crash writer unexpectedly exited successfully")
	} else {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) || exitErr.ExitCode() != 86 {
			t.Fatalf("crash writer error = %v, want exit 86", err)
		}
	}
	entries, err := os.ReadDir(directoryPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || !IsManagedTempName(entries[0].Name()) {
		t.Fatalf("crash residue entries = %#v, want one exact managed temp", entries)
	}
	directory := openCleanupDirectory(t, directoryPath)
	defer directory.Close()
	result, err := CleanupManagedTemps(directory, directoryPath, ManagedTempCleanupPolicy{
		Now: time.Now().UTC(), ExclusiveWriter: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Removed != 1 || result.Retained != 0 {
		t.Fatalf("cleanup result = %#v, want one removal", result)
	}
	entries, err = os.ReadDir(directoryPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("entries after cleanup = %#v, want empty", entries)
	}
}

func TestCleanupManagedTempsCrashWriterHelper(t *testing.T) {
	if os.Getenv("UBITECH_ATOMIC_CRASH_HELPER") != "1" {
		return
	}
	directory := os.Getenv("UBITECH_ATOMIC_CRASH_DIR")
	file, err := os.CreateTemp(directory, ".tmp-*")
	if err != nil {
		os.Exit(87)
	}
	if _, err := file.WriteString("durable partial payload"); err != nil {
		os.Exit(88)
	}
	if err := file.Sync(); err != nil {
		os.Exit(89)
	}
	// Deliberately omit Close/Rename/Remove to model process death between the
	// atomic writer's file fsync and rename checkpoints.
	os.Exit(86)
}

func TestCleanupManagedTempsHonorsGraceWithoutExclusiveWriter(t *testing.T) {
	directoryPath := t.TempDir()
	now := time.Now().UTC().Truncate(time.Second)
	oldPath := filepath.Join(directoryPath, ".tmp-100")
	freshPath := filepath.Join(directoryPath, ".tmp-200")
	writeCleanupFile(t, oldPath)
	writeCleanupFile(t, freshPath)
	if err := os.Chtimes(oldPath, now.Add(-2*time.Hour), now.Add(-2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(freshPath, now.Add(-time.Minute), now.Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	directory := openCleanupDirectory(t, directoryPath)
	defer directory.Close()
	result, err := CleanupManagedTemps(directory, directoryPath, ManagedTempCleanupPolicy{
		Now: now, Grace: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Removed != 1 || result.Retained != 1 {
		t.Fatalf("cleanup result = %#v, want one removed and one retained", result)
	}
	if _, err := os.Lstat(oldPath); !os.IsNotExist(err) {
		t.Fatalf("old residue stat = %v, want removed", err)
	}
	if _, err := os.Lstat(freshPath); err != nil {
		t.Fatalf("fresh residue should remain: %v", err)
	}
}

func TestCleanupManagedTempsSyncsOpenedParentAfterEveryUnlink(t *testing.T) {
	directoryPath := t.TempDir()
	for _, name := range []string{".tmp-11", ".tmp-22"} {
		writeCleanupFile(t, filepath.Join(directoryPath, name))
	}
	directory := openCleanupDirectory(t, directoryPath)
	defer directory.Close()
	synced := make(map[string]bool)
	result, err := cleanupManagedTemps(directory, directoryPath, ManagedTempCleanupPolicy{
		Now: time.Now().UTC(), ExclusiveWriter: true,
	}, uint32(os.Geteuid()), managedTempCleanupHooks{
		afterDirectorySync: func(name string) { synced[name] = true },
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Removed != 2 || len(synced) != 2 || !synced[".tmp-11"] || !synced[".tmp-22"] {
		t.Fatalf("cleanup result=%#v sync checkpoints=%#v, want one fsync per unlink", result, synced)
	}
}

func TestCleanupManagedTempsRejectsDurableTempReferenceBeforeDeletion(t *testing.T) {
	directoryPath := t.TempDir()
	temporaryPath := filepath.Join(directoryPath, ".tmp-123")
	writeCleanupFile(t, temporaryPath)
	directory := openCleanupDirectory(t, directoryPath)
	defer directory.Close()
	_, err := CleanupManagedTemps(directory, directoryPath, ManagedTempCleanupPolicy{
		Now: time.Now().UTC(), ExclusiveWriter: true, DurableReferences: []string{temporaryPath},
	})
	if err == nil || !strings.Contains(err.Error(), "durable reference") {
		t.Fatalf("cleanup error = %v, want durable-reference rejection", err)
	}
	if _, err := os.Lstat(temporaryPath); err != nil {
		t.Fatalf("referenced residue was modified: %v", err)
	}
}

func TestCleanupManagedTempsRejectsUnsafeEvidence(t *testing.T) {
	tests := []struct {
		name   string
		create func(*testing.T, string)
		uid    func() uint32
	}{
		{
			name: "symlink",
			create: func(t *testing.T, path string) {
				target := filepath.Join(filepath.Dir(path), "target")
				writeCleanupFile(t, target)
				if err := os.Symlink(target, path); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "directory",
			create: func(t *testing.T, path string) {
				if err := os.Mkdir(path, 0o700); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "fifo",
			create: func(t *testing.T, path string) {
				if err := syscall.Mkfifo(path, 0o600); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "hard link",
			create: func(t *testing.T, path string) {
				writeCleanupFile(t, path)
				if err := os.Link(path, filepath.Join(filepath.Dir(path), "second-link")); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "wrong owner identity",
			create: func(t *testing.T, path string) {
				writeCleanupFile(t, path)
			},
			uid: func() uint32 { return uint32(os.Geteuid() + 1) },
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			directoryPath := t.TempDir()
			candidatePath := filepath.Join(directoryPath, ".tmp-123")
			test.create(t, candidatePath)
			directory := openCleanupDirectory(t, directoryPath)
			defer directory.Close()
			expectedUID := uint32(os.Geteuid())
			if test.uid != nil {
				expectedUID = test.uid()
			}
			_, err := cleanupManagedTemps(directory, directoryPath, ManagedTempCleanupPolicy{
				Now: time.Now().UTC(), ExclusiveWriter: true,
			}, expectedUID, managedTempCleanupHooks{})
			if err == nil {
				t.Fatal("unsafe managed-temp evidence was accepted")
			}
			if _, statErr := os.Lstat(candidatePath); statErr != nil {
				t.Fatalf("unsafe evidence was removed: %v", statErr)
			}
		})
	}
}

func TestCleanupManagedTempsRejectsLookalikeName(t *testing.T) {
	directoryPath := t.TempDir()
	lookalike := filepath.Join(directoryPath, ".tmp-attacker")
	writeCleanupFile(t, lookalike)
	directory := openCleanupDirectory(t, directoryPath)
	defer directory.Close()
	_, err := CleanupManagedTemps(directory, directoryPath, ManagedTempCleanupPolicy{
		Now: time.Now().UTC(), ExclusiveWriter: true,
	})
	if err == nil || !strings.Contains(err.Error(), "unknown atomic temporary") {
		t.Fatalf("cleanup error = %v, want unknown-artifact rejection", err)
	}
	if _, err := os.Lstat(lookalike); err != nil {
		t.Fatalf("lookalike was removed: %v", err)
	}
}

func TestCleanupManagedTempsRejectsDirectoryIdentitySwap(t *testing.T) {
	parent := t.TempDir()
	directoryPath := filepath.Join(parent, "managed")
	if err := os.Mkdir(directoryPath, 0o700); err != nil {
		t.Fatal(err)
	}
	originalPath := filepath.Join(directoryPath, ".tmp-123")
	writeCleanupFile(t, originalPath)
	directory := openCleanupDirectory(t, directoryPath)
	defer directory.Close()
	movedPath := filepath.Join(parent, "moved")
	if err := os.Rename(directoryPath, movedPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(directoryPath, 0o700); err != nil {
		t.Fatal(err)
	}
	replacementPath := filepath.Join(directoryPath, ".tmp-123")
	writeCleanupFile(t, replacementPath)
	_, err := CleanupManagedTemps(directory, directoryPath, ManagedTempCleanupPolicy{
		Now: time.Now().UTC(), ExclusiveWriter: true,
	})
	if err == nil || !strings.Contains(err.Error(), "directory changed") {
		t.Fatalf("cleanup error = %v, want directory identity rejection", err)
	}
	for _, path := range []string{filepath.Join(movedPath, ".tmp-123"), replacementPath} {
		if _, err := os.Lstat(path); err != nil {
			t.Fatalf("directory-swap evidence %s was modified: %v", path, err)
		}
	}
}

func TestCleanupManagedTempsRejectsSymlinkedAncestor(t *testing.T) {
	parent := t.TempDir()
	realParent := filepath.Join(parent, "real")
	directoryPath := filepath.Join(realParent, "managed")
	if err := os.MkdirAll(directoryPath, 0o700); err != nil {
		t.Fatal(err)
	}
	residue := filepath.Join(directoryPath, ".tmp-123")
	writeCleanupFile(t, residue)
	alias := filepath.Join(parent, "alias")
	if err := os.Symlink(realParent, alias); err != nil {
		t.Fatal(err)
	}
	aliasDirectory := filepath.Join(alias, "managed")
	directory := openCleanupDirectory(t, aliasDirectory)
	defer directory.Close()
	_, err := CleanupManagedTemps(directory, aliasDirectory, ManagedTempCleanupPolicy{
		Now: time.Now().UTC(), ExclusiveWriter: true,
	})
	if err == nil || !strings.Contains(err.Error(), "contains a symbolic link") {
		t.Fatalf("cleanup error = %v, want symlinked-ancestor rejection", err)
	}
	if _, err := os.Lstat(residue); err != nil {
		t.Fatalf("symlink-root residue was modified: %v", err)
	}
}

func TestCleanupManagedTempsRejectsConcurrentFileReplacement(t *testing.T) {
	directoryPath := t.TempDir()
	candidatePath := filepath.Join(directoryPath, ".tmp-123")
	writeCleanupFile(t, candidatePath)
	directory := openCleanupDirectory(t, directoryPath)
	defer directory.Close()
	originalPath := filepath.Join(directoryPath, "original-residue")
	_, err := cleanupManagedTemps(directory, directoryPath, ManagedTempCleanupPolicy{
		Now: time.Now().UTC(), ExclusiveWriter: true,
	}, uint32(os.Geteuid()), managedTempCleanupHooks{
		beforeUnlink: func(string) {
			if err := os.Rename(candidatePath, originalPath); err != nil {
				t.Fatal(err)
			}
			writeCleanupFile(t, candidatePath)
		},
	})
	if err == nil || !strings.Contains(err.Error(), "changed before unlink") {
		t.Fatalf("cleanup error = %v, want concurrent replacement rejection", err)
	}
	for _, path := range []string{originalPath, candidatePath} {
		if _, err := os.Lstat(path); err != nil {
			t.Fatalf("concurrent replacement evidence %s was modified: %v", path, err)
		}
	}
}

func TestCleanupManagedTempsRequiresSecureCanonicalDirectory(t *testing.T) {
	directoryPath := t.TempDir()
	directory := openCleanupDirectory(t, directoryPath)
	defer directory.Close()
	if _, err := CleanupManagedTemps(directory, directoryPath+string(os.PathSeparator), ManagedTempCleanupPolicy{
		Now: time.Now().UTC(), ExclusiveWriter: true,
	}); err == nil {
		t.Fatal("non-canonical directory path was accepted")
	}
	if err := os.Chmod(directoryPath, 0o777); err != nil {
		t.Fatal(err)
	}
	if _, err := CleanupManagedTemps(directory, directoryPath, ManagedTempCleanupPolicy{
		Now: time.Now().UTC(), ExclusiveWriter: true,
	}); err == nil || !strings.Contains(err.Error(), "writable by another") {
		t.Fatalf("insecure directory error = %v", err)
	}
}

func openCleanupDirectory(t *testing.T, path string) *os.File {
	t.Helper()
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		t.Fatal(err)
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		_ = syscall.Close(fd)
		t.Fatal("open cleanup directory returned nil file")
	}
	return file
}

func writeCleanupFile(t *testing.T, path string) {
	t.Helper()
	if err := os.WriteFile(path, []byte("residue"), 0o600); err != nil {
		t.Fatal(err)
	}
}
