//go:build linux

package handofftransform

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
	"golang.org/x/sys/unix"
)

const testPrivilegedImage = "registry.example/handoff-fs-helper@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

type privilegedRunner struct {
	t             *testing.T
	calls         [][]string
	tamperReceipt bool
}

func (runner *privilegedRunner) Run(_ context.Context, name string, args []string, _ []string) (driver.Result, error) {
	runner.t.Helper()
	if name != "docker-test" {
		return driver.Result{}, errors.New("unexpected Docker binary")
	}
	runner.calls = append(runner.calls, append([]string(nil), args...))
	if len(args) >= 2 && args[0] == "container" && args[1] == "ls" {
		return driver.Result{}, nil
	}
	if len(args) == 0 || args[0] != "run" {
		return driver.Result{}, errors.New("unexpected Docker operation")
	}
	control := ""
	for index := 0; index+1 < len(args); index++ {
		if args[index] != "--mount" || !strings.Contains(args[index+1], ",dst=/control") {
			continue
		}
		for _, field := range strings.Split(args[index+1], ",") {
			if strings.HasPrefix(field, "src=") {
				control = strings.TrimPrefix(field, "src=")
			}
		}
	}
	if control == "" {
		return driver.Result{}, errors.New("control bind is absent")
	}
	var request privilegedWorkerRequest
	if err := readStrictOwnerJSON(filepath.Join(control, "request.json"), os.Getuid(), &request); err != nil {
		return driver.Result{}, err
	}
	entry := Entry{
		Resource: request.ResourceName, Path: ".", Type: Directory, Mode: 0o700,
		UID: uint32(os.Getuid()), GID: uint32(os.Getgid()), LinkCount: 1,
	}
	digest, err := entryDigest([]Entry{entry})
	if err != nil {
		return driver.Result{}, err
	}
	receipt := privilegedWorkerReceipt{
		SchemaVersion: privilegedProtocolSchema, Operation: request.Operation,
		TransactionID: request.TransactionID, DataRequestSHA256: request.DataRequestSHA256,
		ResourceName: request.ResourceName, ImageDigest: request.ImageDigest,
		RequestSHA256: request.RequestSHA256, Entries: []Entry{entry}, EntriesSHA256: digest,
	}
	if runner.tamperReceipt {
		receipt.TransactionID = "handoff_ffffffffffffffffffffffffffffffff"
	}
	receipt, err = sealPrivilegedReceipt(receipt)
	if err != nil {
		return driver.Result{}, err
	}
	raw, err := json.Marshal(receipt)
	if err != nil {
		return driver.Result{}, err
	}
	if err := os.WriteFile(filepath.Join(control, "receipt.json"), append(raw, '\n'), 0o600); err != nil {
		return driver.Result{}, err
	}
	return driver.Result{}, nil
}

func TestDockerPrivilegedTreeFSRunsOnlyHardenedDigestWorker(t *testing.T) {
	control := t.TempDir()
	if err := os.Chmod(control, 0o700); err != nil {
		t.Fatal(err)
	}
	runner := &privilegedRunner{t: t}
	filesystem, err := NewDockerPrivilegedTreeFS(DockerPrivilegedTreeFSOptions{
		Runner: runner, DockerBinary: "docker-test", ControlRoot: control, UID: os.Getuid(), GID: os.Getgid(),
	})
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(control, "source")
	mustMkdirAll(t, source, 0o700)
	result, err := filesystem.inventory(context.Background(), PrivilegedTreeRequest{
		SchemaVersion: SchemaVersion, Operation: PrivilegedInventory,
		TransactionID: testTransaction, RequestSHA256: strings.Repeat("a", 64),
		ResourceName: "service_data", ImageDigest: testPrivilegedImage,
		SourcePath: source, SourceOwners: []Owner{{UID: uint32(os.Getuid()), GID: uint32(os.Getgid())}},
		TargetOwners: []Owner{{UID: uint32(os.Getuid()), GID: uint32(os.Getgid())}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Entries) != 1 || result.Entries[0].Path != "." {
		t.Fatalf("unexpected inventory receipt: %#v", result)
	}
	if len(runner.calls) != 3 {
		t.Fatalf("Docker calls = %d, want residual-check/run/residual-check", len(runner.calls))
	}
	run := strings.Join(runner.calls[1], "\n")
	for _, required := range []string{
		"--pull=never", "--network=none", "--read-only", "--user=0:0", "--cap-drop=ALL",
		"--cap-add=CHOWN", "--cap-add=DAC_OVERRIDE", "--cap-add=FOWNER",
		"--security-opt=no-new-privileges:true", "--pids-limit=64", testPrivilegedImage,
		"HANDOFF_FS_IMAGE_DIGEST=" + testPrivilegedImage,
	} {
		if !strings.Contains(run, required) {
			t.Fatalf("hardened Docker invocation lacks %q: %v", required, runner.calls[1])
		}
	}
	for _, forbidden := range []string{"--privileged", "/var/run/docker.sock", "/run/docker.sock", "--pull=always"} {
		if strings.Contains(run, forbidden) {
			t.Fatalf("hardened Docker invocation contains %q", forbidden)
		}
	}
	if entries, err := os.ReadDir(control); err != nil || len(entries) != 1 || entries[0].Name() != "source" {
		t.Fatalf("owner control residue remains: entries=%v err=%v", entries, err)
	}
}

func TestDockerPrivilegedTreeFSRejectsReceiptFromAnotherTransaction(t *testing.T) {
	control := t.TempDir()
	if err := os.Chmod(control, 0o700); err != nil {
		t.Fatal(err)
	}
	runner := &privilegedRunner{t: t, tamperReceipt: true}
	filesystem, err := NewDockerPrivilegedTreeFS(DockerPrivilegedTreeFSOptions{
		Runner: runner, DockerBinary: "docker-test", ControlRoot: control, UID: os.Getuid(), GID: os.Getgid(),
	})
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(control, "source")
	mustMkdirAll(t, source, 0o700)
	_, err = filesystem.inventory(context.Background(), PrivilegedTreeRequest{
		SchemaVersion: SchemaVersion, Operation: PrivilegedInventory,
		TransactionID: testTransaction, RequestSHA256: strings.Repeat("a", 64),
		ResourceName: "service_data", ImageDigest: testPrivilegedImage, SourcePath: source,
		SourceOwners: []Owner{{UID: uint32(os.Getuid()), GID: uint32(os.Getgid())}},
		TargetOwners: []Owner{{UID: uint32(os.Getuid()), GID: uint32(os.Getgid())}},
	})
	if err == nil || !strings.Contains(err.Error(), "identity") {
		t.Fatalf("foreign transaction receipt was accepted: %v", err)
	}
}

func TestDockerPrivilegedTreeFSRejectsBareRemovalKindBeforeDocker(t *testing.T) {
	control := t.TempDir()
	if err := os.Chmod(control, 0o700); err != nil {
		t.Fatal(err)
	}
	runner := &privilegedRunner{t: t}
	filesystem, err := NewDockerPrivilegedTreeFS(DockerPrivilegedTreeFSOptions{
		Runner: runner, DockerBinary: "docker-test", ControlRoot: control, UID: os.Getuid(), GID: os.Getgid(),
	})
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(control, "target")
	mustMkdirAll(t, filepath.Join(target, "service"), 0o700)
	_, err = filesystem.remove(context.Background(), PrivilegedTreeRequest{
		SchemaVersion: SchemaVersion, Operation: PrivilegedRemove,
		TransactionID: testTransaction, RequestSHA256: strings.Repeat("a", 64),
		ResourceName: "service_data", ImageDigest: testPrivilegedImage,
		TargetRoot: target, TargetRelative: "service",
		SourceOwners:   []Owner{{UID: uint32(os.Getuid()), GID: uint32(os.Getgid())}},
		TargetOwners:   []Owner{{UID: uint32(os.Getuid()), GID: uint32(os.Getgid())}},
		ExpectedTarget: []Entry{{Resource: "service_data", Path: ".", Type: Directory, Mode: 0o700, UID: uint32(os.Getuid()), GID: uint32(os.Getgid()), LinkCount: 1}},
		RemovalProof:   PrivilegedRemovalProof{Kind: RemovalFencedPublication},
	})
	if err == nil || !strings.Contains(err.Error(), "exact proof") {
		t.Fatalf("bare removal kind was accepted: %v", err)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("invalid removal reached Docker %d times", len(runner.calls))
	}
	if _, err := os.Lstat(filepath.Join(target, "service")); err != nil {
		t.Fatalf("invalid removal changed the target: %v", err)
	}
}

func TestPrivilegedInventoryRejectsSpecialSymlinkHardlinkAndUnknownOwner(t *testing.T) {
	owners := []Owner{{UID: uint32(os.Getuid()), GID: uint32(os.Getgid())}}
	for name, create := range map[string]func(*testing.T, string){
		"fifo": func(t *testing.T, root string) {
			if err := unix.Mkfifo(filepath.Join(root, "pipe"), 0o600); err != nil {
				t.Fatal(err)
			}
		},
		"symlink": func(t *testing.T, root string) {
			if err := os.Symlink("target", filepath.Join(root, "link")); err != nil {
				t.Fatal(err)
			}
		},
		"hardlink": func(t *testing.T, root string) {
			mustWrite(t, filepath.Join(root, "one"), []byte("x"), 0o600)
			if err := os.Link(filepath.Join(root, "one"), filepath.Join(root, "two")); err != nil {
				t.Fatal(err)
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			if err := os.Chmod(root, 0o700); err != nil {
				t.Fatal(err)
			}
			create(t, root)
			if _, err := workerInventory(context.Background(), root, "service_data", owners); err == nil {
				t.Fatalf("unsafe %s was inventoried", name)
			}
		})
	}
	unknown := []Entry{{Resource: "service_data", Path: ".", Type: Directory, Mode: 0o700, UID: 42424, GID: 42424, LinkCount: 1}}
	if err := validatePrivilegedEntries(Resource{Name: "service_data"}, unknown, owners); err == nil || !strings.Contains(err.Error(), "undeclared owner") {
		t.Fatalf("unknown container owner was accepted: %v", err)
	}
}
