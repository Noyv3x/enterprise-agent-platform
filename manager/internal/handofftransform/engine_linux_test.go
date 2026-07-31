//go:build linux

package handofftransform

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testTransaction = "handoff_0123456789abcdef0123456789abcdef"

func TestStageByteExactTreeAndSecret(t *testing.T) {
	fixture := newFixture(t)
	fixed := time.Unix(1_800_000_000, 123_000_000).UTC()
	attachment := filepath.Join(fixture.source, "data", "attachments")
	mustMkdirAll(t, filepath.Join(attachment, "private", "1"), 0o700)
	file := filepath.Join(attachment, "private", "1", "hello.txt")
	mustWrite(t, file, []byte("unchanged user bytes\n"), 0o640)
	if err := os.Chtimes(file, fixed, fixed); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(fixture.source, "manager", "secrets", "manager-token")
	mustMkdirAll(t, filepath.Dir(secret), 0o700)
	mustWrite(t, secret, []byte("capability-secret\n"), 0o600)
	sourceDigest := fileDigest(t, file)

	request := fixture.request([]Resource{
		{Name: "attachments", Kind: ByteExactTree, Source: "data/attachments", Target: "data/attachments", Type: Directory, Required: true},
		{Name: "manager_token", Kind: SecretFile, Source: "manager/secrets/manager-token", Target: "manager/secrets/manager-token", Type: RegularFile, Required: true},
	})
	engine := Engine{Now: func() time.Time { return fixed }}
	result, err := engine.Stage(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if result.ManifestSHA256 == "" || !sha256Pattern.MatchString(result.ManifestSHA256) {
		t.Fatalf("invalid manifest digest %q", result.ManifestSHA256)
	}
	if result.Manifest.CreatedAt != fixed || len(result.Manifest.Resources) != 2 {
		t.Fatalf("unexpected manifest: %#v", result.Manifest)
	}
	stagedFile := filepath.Join(result.StagingRoot, "data", "attachments", "private", "1", "hello.txt")
	if got := fileDigest(t, stagedFile); got != sourceDigest {
		t.Fatalf("staged content changed: %s != %s", got, sourceDigest)
	}
	if got := fileDigest(t, file); got != sourceDigest {
		t.Fatalf("source content changed: %s != %s", got, sourceDigest)
	}
	secretInfo, err := os.Lstat(filepath.Join(result.StagingRoot, "manager", "secrets", "manager-token"))
	if err != nil {
		t.Fatal(err)
	}
	if secretInfo.Mode().Perm() != 0o600 {
		t.Fatalf("secret mode changed: %o", secretInfo.Mode().Perm())
	}
	if _, err := os.Lstat(fixture.target); !os.IsNotExist(err) {
		t.Fatalf("Stage published final target: %v", err)
	}
	if err := engine.Cleanup(request); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(result.StagingRoot); !os.IsNotExist(err) {
		t.Fatalf("staging still exists after cleanup: %v", err)
	}
}

func TestByteExactValidationRejectsOwnerDrift(t *testing.T) {
	source := Entry{Path: ".", Type: Directory, Mode: 0o700, UID: 1000, GID: 1000, ModifiedNanos: 1}
	target := source
	target.UID = 1001
	err := validateByteExact(ValidationInput{
		Resource: Resource{Kind: ByteExactTree}, SourceEntries: []Entry{source}, TargetEntries: []Entry{target},
	})
	if err == nil || !strings.Contains(err.Error(), "differs from source") {
		t.Fatalf("byte-exact owner drift was accepted: %v", err)
	}
}

func TestStructuredResourceRequiresTransformerAndValidator(t *testing.T) {
	fixture := newFixture(t)
	mustMkdirAll(t, filepath.Join(fixture.source, "data"), 0o700)
	mustWrite(t, filepath.Join(fixture.source, "data", "platform.db"), []byte("not sqlite"), 0o600)
	request := fixture.request([]Resource{{
		Name: "platform_database", Kind: Structured, Source: "data/platform.db", Target: "data/platform.db",
		Type: RegularFile, Required: true, SchemaIdentifier: "platform-db", SchemaVersion: 1,
	}})
	_, err := (Engine{}).Stage(context.Background(), request)
	var unsupported *UnsupportedSchemaError
	if !errors.As(err, &unsupported) || unsupported.Resource != "platform_database" {
		t.Fatalf("expected fail-closed schema error, got %v", err)
	}
	if _, statErr := os.Lstat(fixture.stage()); !os.IsNotExist(statErr) {
		t.Fatalf("unsupported schema created staging: %v", statErr)
	}
}

func TestGeneratedFreshManagerState(t *testing.T) {
	fixture := newFixture(t)
	transform := TransformFunc(func(_ context.Context, input TransformInput) error {
		if input.SourcePath != "" || input.Mapping.Source.ProfileID != "ubitech-agent-v1" || input.Mapping.Target.ProfileID != "agent-platform-v1" {
			return errors.New("unexpected technical mapping")
		}
		return os.WriteFile(input.TargetPath, []byte(`{"schema_version":1,"current":"bridge"}`+"\n"), 0o600)
	})
	validator := ValidateFunc(func(_ context.Context, input ValidationInput) error {
		var value struct {
			SchemaVersion int    `json:"schema_version"`
			Current       string `json:"current"`
		}
		raw, err := os.ReadFile(input.TargetPath)
		if err != nil {
			return err
		}
		if err := json.Unmarshal(raw, &value); err != nil {
			return err
		}
		if value.SchemaVersion != 1 || value.Current != "bridge" {
			return errors.New("invalid fresh Manager state")
		}
		return nil
	})
	request := fixture.request([]Resource{{
		Name: "manager_current", Kind: Generated, Target: "manager/state.json", Type: RegularFile,
		Required: true, SchemaIdentifier: "target-manager-state", SchemaVersion: 1,
		TransformationSHA256: semanticDigest("generated-manager-current-test-v1"),
		Transformer:          transform, Validator: validator,
	}})
	result, err := (Engine{}).Stage(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(filepath.Join(result.StagingRoot, "manager", "state.json")); err != nil || !strings.Contains(string(got), `"bridge"`) {
		t.Fatalf("fresh Manager state missing: %q, %v", got, err)
	}
}

func TestStructuredTransformerReceivesReadOnlyTransactionInput(t *testing.T) {
	fixture := newFixture(t)
	source := filepath.Join(fixture.source, "data", "runtime.json")
	mustMkdirAll(t, filepath.Dir(source), 0o700)
	mustWrite(t, source, []byte(`{"schema_version":1,"profile":"source","text":"user source text"}`), 0o600)
	request := fixture.request([]Resource{{
		Name: "runtime", Kind: Structured, Source: "data/runtime.json", Target: "data/runtime.json",
		Type: RegularFile, Required: true, SchemaIdentifier: "runtime-test", SchemaVersion: 1,
		TransformationSHA256: semanticDigest("runtime-test-source-to-target-v1"),
		Transformer: TransformFunc(func(_ context.Context, input TransformInput) error {
			if input.SourcePath == source || !strings.Contains(input.SourcePath, inputDirectoryName) {
				return errors.New("authoritative source path was exposed")
			}
			info, err := os.Lstat(input.SourcePath)
			if err != nil {
				return err
			}
			if info.Mode().Perm()&0o222 != 0 {
				return errors.New("transaction input is writable")
			}
			raw, err := os.ReadFile(input.SourcePath)
			if err != nil {
				return err
			}
			return os.WriteFile(input.TargetPath, []byte(strings.ReplaceAll(string(raw), `"source"`, `"target"`)), 0o600)
		}),
		Validator: ValidateFunc(func(_ context.Context, input ValidationInput) error {
			raw, err := os.ReadFile(input.TargetPath)
			if err != nil {
				return err
			}
			if !strings.Contains(string(raw), `"profile":"target"`) || !strings.Contains(string(raw), `"text":"user source text"`) {
				return errors.New("structured invariant failed")
			}
			return nil
		}),
	}})
	result, err := (Engine{}).Stage(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(result.StagingRoot, inputDirectoryName)); !os.IsNotExist(err) {
		t.Fatalf("read-only transaction input was retained: %v", err)
	}
	if got, err := os.ReadFile(source); err != nil || !strings.Contains(string(got), `"profile":"source"`) {
		t.Fatalf("authoritative source changed: %q, %v", got, err)
	}
}

func TestTransformerCannotMutateAuthoritativeSource(t *testing.T) {
	fixture := newFixture(t)
	source := filepath.Join(fixture.source, "data", "runtime.json")
	mustMkdirAll(t, filepath.Dir(source), 0o700)
	mustWrite(t, source, []byte(`{"schema_version":1}`), 0o600)
	request := fixture.request([]Resource{{
		Name: "runtime", Kind: Structured, Source: "data/runtime.json", Target: "data/runtime.json",
		Type: RegularFile, Required: true, SchemaIdentifier: "runtime", SchemaVersion: 1,
		TransformationSHA256: semanticDigest("runtime-mutating-transformer-test-v1"),
		Transformer: TransformFunc(func(_ context.Context, input TransformInput) error {
			if err := os.WriteFile(input.TargetPath, []byte(`{"schema_version":1}`), 0o600); err != nil {
				return err
			}
			return os.WriteFile(input.SourcePath, []byte(`{"schema_version":2}`), 0o600)
		}),
		Validator: ValidateFunc(func(context.Context, ValidationInput) error { return nil }),
	}})
	_, err := (Engine{}).Stage(context.Background(), request)
	if err == nil {
		t.Fatal("structured input mutation was accepted")
	}
	if got, readErr := os.ReadFile(source); readErr != nil || string(got) != `{"schema_version":1}` {
		t.Fatalf("authoritative source was modified: %q, %v", got, readErr)
	}
	if _, statErr := os.Lstat(fixture.stage()); !os.IsNotExist(statErr) {
		t.Fatalf("failed transaction staging was not cleaned: %v", statErr)
	}
}

func TestValidatorMutationFailsAndCleans(t *testing.T) {
	fixture := newFixture(t)
	source := filepath.Join(fixture.source, "data", "runtime.json")
	mustMkdirAll(t, filepath.Dir(source), 0o700)
	mustWrite(t, source, []byte(`{"schema_version":1}`), 0o600)
	request := fixture.request([]Resource{{
		Name: "runtime", Kind: Structured, Source: "data/runtime.json", Target: "data/runtime.json",
		Type: RegularFile, Required: true, SchemaIdentifier: "runtime", SchemaVersion: 1,
		TransformationSHA256: semanticDigest("runtime-mutating-validator-test-v1"),
		Transformer: TransformFunc(func(_ context.Context, input TransformInput) error {
			return os.WriteFile(input.TargetPath, []byte(`{"schema_version":1}`), 0o600)
		}),
		Validator: ValidateFunc(func(_ context.Context, input ValidationInput) error {
			return os.WriteFile(input.TargetPath, []byte(`{"schema_version":2}`), 0o600)
		}),
	}})
	_, err := (Engine{}).Stage(context.Background(), request)
	if err == nil || !strings.Contains(err.Error(), "validator mutated target resource runtime") {
		t.Fatalf("validator mutation was not detected: %v", err)
	}
	if _, statErr := os.Lstat(fixture.stage()); !os.IsNotExist(statErr) {
		t.Fatalf("failed transaction staging was not cleaned: %v", statErr)
	}
}

func TestCrashReplayRebuildsOwnedStaging(t *testing.T) {
	fixture := newFixture(t)
	source := filepath.Join(fixture.source, "data", "attachments", "a.txt")
	mustMkdirAll(t, filepath.Dir(source), 0o700)
	mustWrite(t, source, []byte("a"), 0o600)
	request := fixture.request([]Resource{{Name: "attachment", Kind: ByteExactFile, Source: "data/attachments/a.txt", Target: "data/attachments/a.txt", Type: RegularFile, Required: true}})
	crashing := Engine{Fault: func(point Point) error {
		if point.Name == "resource_synced" {
			return ErrInjectedCrash
		}
		return nil
	}}
	if _, err := crashing.Stage(context.Background(), request); !errors.Is(err, ErrInjectedCrash) {
		t.Fatalf("expected injected crash, got %v", err)
	}
	if _, err := os.Lstat(fixture.stage()); err != nil {
		t.Fatalf("crash staging was not retained: %v", err)
	}
	result, err := (Engine{}).Stage(context.Background(), request)
	if err != nil {
		t.Fatalf("replay did not converge: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(result.StagingRoot, "data", "attachments", "a.txt")); err != nil || string(got) != "a" {
		t.Fatalf("replayed content is wrong: %q, %v", got, err)
	}
}

func TestCleanupRefusesUnknownStagingObject(t *testing.T) {
	fixture := newFixture(t)
	source := filepath.Join(fixture.source, "data", "attachments", "a.txt")
	mustMkdirAll(t, filepath.Dir(source), 0o700)
	mustWrite(t, source, []byte("a"), 0o600)
	request := fixture.request([]Resource{{Name: "attachment", Kind: ByteExactFile, Source: "data/attachments/a.txt", Target: "data/attachments/a.txt", Type: RegularFile, Required: true}})
	crashing := Engine{Fault: func(point Point) error {
		if point.Name == "resource_synced" {
			return ErrInjectedCrash
		}
		return nil
	}}
	_, _ = crashing.Stage(context.Background(), request)
	mustWrite(t, filepath.Join(fixture.stage(), "unknown"), []byte("do not delete"), 0o600)
	err := (Engine{}).Cleanup(request)
	if err == nil || !strings.Contains(err.Error(), "unknown file") {
		t.Fatalf("unknown staging object was accepted: %v", err)
	}
	if _, statErr := os.Lstat(filepath.Join(fixture.stage(), "unknown")); statErr != nil {
		t.Fatalf("unknown evidence was deleted: %v", statErr)
	}
}

func TestCopyStructuredFileRejectsBytesBeyondManifestBound(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	target := filepath.Join(root, "target")
	mustWrite(t, source, []byte("ab"), 0o600)
	digest := sha256.Sum256([]byte("a"))
	entry := Entry{
		Path: ".", Type: RegularFile, Mode: 0o600, Size: 1,
		ModifiedNanos: time.Now().UnixNano(), SHA256: hex.EncodeToString(digest[:]),
	}
	err := copyStructuredFile(context.Background(), source, target, entry)
	if err == nil || !strings.Contains(err.Error(), "exact copy bound") {
		t.Fatalf("structured copy accepted bytes beyond its manifest: %v", err)
	}
	if info, statErr := os.Lstat(target); statErr != nil || info.Size() != entry.Size {
		t.Fatalf("structured copy wrote beyond its manifest bound: info=%v err=%v", info, statErr)
	}
}

func TestRejectsSymlinkAndHardlinkSources(t *testing.T) {
	for _, test := range []struct {
		name  string
		setup func(*testing.T, string)
	}{
		{name: "symlink", setup: func(t *testing.T, path string) {
			outside := filepath.Join(filepath.Dir(path), "outside")
			mustWrite(t, outside, []byte("x"), 0o600)
			if err := os.Symlink(outside, path); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "hardlink", setup: func(t *testing.T, path string) {
			mustWrite(t, path, []byte("x"), 0o600)
			if err := os.Link(path, path+".other"); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newFixture(t)
			path := filepath.Join(fixture.source, "data", "attachments", "a")
			mustMkdirAll(t, filepath.Dir(path), 0o700)
			test.setup(t, path)
			request := fixture.request([]Resource{{Name: "attachment", Kind: ByteExactFile, Source: "data/attachments/a", Target: "data/attachments/a", Type: RegularFile, Required: true}})
			if _, err := (Engine{}).Stage(context.Background(), request); err == nil {
				t.Fatal("unsafe source was accepted")
			}
		})
	}
}

func TestRejectsUnsafeSecretsAndInheritedManagerState(t *testing.T) {
	t.Run("wide secret", func(t *testing.T) {
		fixture := newFixture(t)
		path := filepath.Join(fixture.source, "manager", "secrets", "manager-token")
		mustMkdirAll(t, filepath.Dir(path), 0o700)
		mustWrite(t, path, []byte("secret"), 0o644)
		request := fixture.request([]Resource{{Name: "manager_token", Kind: SecretFile, Source: "manager/secrets/manager-token", Target: "manager/secrets/manager-token", Type: RegularFile, Required: true}})
		if _, err := (Engine{}).Stage(context.Background(), request); err == nil || !strings.Contains(err.Error(), "owner-only") {
			t.Fatalf("wide secret was accepted: %v", err)
		}
	})
	t.Run("operation journal", func(t *testing.T) {
		fixture := newFixture(t)
		request := fixture.request([]Resource{{Name: "operation", Kind: ByteExactFile, Source: "manager/operations/op.json", Target: "manager/operations/op.json", Type: RegularFile, Required: true}})
		if _, err := (Engine{}).Stage(context.Background(), request); err == nil {
			t.Fatalf("source operation inheritance was accepted: %v", err)
		}
	})
}

func TestRejectsExistingTargetOverlapsAndImpossibleCapacity(t *testing.T) {
	t.Run("existing target", func(t *testing.T) {
		fixture := newFixture(t)
		mustMkdirAll(t, fixture.target, 0o700)
		request := fixture.request([]Resource{{Name: "generated", Kind: Generated, Target: "data/current.json", Type: RegularFile, Required: true, SchemaIdentifier: "test", SchemaVersion: 1, TransformationSHA256: semanticDigest("x"), Transformer: writeGenerated("x"), Validator: noMutationValidator()}})
		if _, err := (Engine{}).Stage(context.Background(), request); err == nil || !strings.Contains(err.Error(), "already exists") {
			t.Fatalf("existing target was accepted: %v", err)
		}
	})
	t.Run("overlap", func(t *testing.T) {
		fixture := newFixture(t)
		request := fixture.request([]Resource{
			{Name: "one", Kind: Generated, Target: "data/a", Type: Directory, Required: true, SchemaIdentifier: "test", SchemaVersion: 1, TransformationSHA256: semanticDigest("empty-directory"), Transformer: makeGeneratedDirectory(), Validator: noMutationValidator()},
			{Name: "two", Kind: Generated, Target: "data/a/b", Type: RegularFile, Required: true, SchemaIdentifier: "test", SchemaVersion: 1, TransformationSHA256: semanticDigest("x"), Transformer: writeGenerated("x"), Validator: noMutationValidator()},
		})
		if _, err := (Engine{}).Stage(context.Background(), request); err == nil || !strings.Contains(err.Error(), "overlaps") {
			t.Fatalf("overlapping resources were accepted: %v", err)
		}
	})
	t.Run("capacity", func(t *testing.T) {
		fixture := newFixture(t)
		request := fixture.request([]Resource{{Name: "generated", Kind: Generated, Target: "data/current.json", Type: RegularFile, Required: true, SchemaIdentifier: "test", SchemaVersion: 1, TransformationSHA256: semanticDigest("x"), Transformer: writeGenerated("x"), Validator: noMutationValidator()}})
		request.ReserveBytes = ^uint64(0)
		if _, err := (Engine{}).Stage(context.Background(), request); err == nil || !strings.Contains(err.Error(), "insufficient target capacity") {
			t.Fatalf("impossible capacity was accepted: %v", err)
		}
	})
}

func TestCurrentSchemaGapsAreClosed(t *testing.T) {
	if gaps := CurrentSchemaGaps(); len(gaps) != 0 {
		t.Fatalf("current production schemas remain unsupported: %#v", gaps)
	}
}

type fixture struct {
	t      *testing.T
	root   string
	source string
	target string
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "source")
	mustMkdirAll(t, source, 0o700)
	return fixture{t: t, root: root, source: source, target: filepath.Join(root, "agent-platform")}
}

func (f fixture) request(resources []Resource) Request {
	return Request{TransactionID: testTransaction, SourceRoot: f.source, TargetRoot: f.target, Resources: resources, ReserveBytes: 1}
}

func (f fixture) stage() string {
	return filepath.Join(f.root, ".agent-platform."+testTransaction+".staging")
}

func mustMkdirAll(t *testing.T, path string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(path, mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func mustWrite(t *testing.T, path string, contents []byte, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, contents, mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func fileDigest(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func writeGenerated(value string) TransformFunc {
	return func(_ context.Context, input TransformInput) error {
		return os.WriteFile(input.TargetPath, []byte(value), 0o600)
	}
}

func makeGeneratedDirectory() TransformFunc {
	return func(_ context.Context, input TransformInput) error { return os.Mkdir(input.TargetPath, 0o700) }
}

func noMutationValidator() ValidateFunc {
	return func(context.Context, ValidationInput) error { return nil }
}
