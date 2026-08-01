//go:build linux

// Package handoffhost owns the narrow Linux host boundary used by the
// namespace-handoff coordinator. It installs and proves the persistent helper
// but deliberately performs no data migration or Docker mutation.
package handoffhost

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
)

// ArgvSHA256 returns the deterministic static identity of one helper command
// line. The live /proc argv is still compared element-for-element with the
// HelperSpec; this digest is the write-once journal projection used across
// PID and boot changes.
func ArgvSHA256(argv []string) string {
	encoded, _ := json.Marshal(argv)
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

const (
	HelperSubcommand = "namespace-handoff-helper"
	helperDirectory  = "helper"
	journalBasename  = "journal.json"
)

var (
	transactionPattern = regexp.MustCompile(`^handoff_[0-9a-f]{32}$`)
	sha256Pattern      = regexp.MustCompile(`^[0-9a-f]{64}$`)
	bootIDPattern      = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

// Runner is the only command execution capability used by this package. A
// production runner invokes systemctl; tests use a stateful fake.
type Runner interface {
	Run(context.Context, string, ...string) ([]byte, error)
}

// OwnerHost is the interface consumed by the handoff owner. Its scope is
// intentionally limited to one persistent helper and listener transfer.
type OwnerHost interface {
	Resolve(ArmRequest) (HelperSpec, error)
	Arm(context.Context, ArmRequest) (ArmResult, error)
	Inspect(context.Context, HelperSpec) (HelperProof, error)
	Remove(context.Context, RemovalRequest) (RemovalResult, error)
	OpenListenerReceiver(string, string) (ListenerAcceptor, error)
	SendListeners(context.Context, string, string, []NamedListener) error
}

type ListenerAcceptor interface {
	Path() string
	Accept(context.Context) ([]NamedListener, error)
	Close() error
}

// ArmRequest contains only already-resolved, canonical host paths. ArtifactSHA256
// must be the digest verified against the immutable release artifact by the
// caller; Arm verifies the bytes again before installing them.
type ArmRequest struct {
	TargetProfile        identity.Profile
	TransactionID        string
	TransactionDirectory string
	ArtifactPath         string
	ArtifactSHA256       string
	UnitDirectory        string
	JournalPath          string
}

// HelperSpec is the deterministic static identity of one transaction helper.
// It is safe to persist in the handoff journal before inspecting runtime state.
type HelperSpec struct {
	TransactionID        string
	TargetProfileID      string
	TransactionDirectory string
	UnitName             string
	UnitPath             string
	UnitSHA256           string
	ExecutablePath       string
	ExecutableSHA256     string
	JournalPath          string
	ListenerSocketPath   string
	Argv                 []string
}

// HelperProof binds the static spec to the exact active user-systemd process.
// PID and BootID are observations, not durable helper identity: both can
// legitimately change when systemd resumes the enabled unit after reboot.
type HelperProof struct {
	TransactionID    string
	UnitName         string
	UnitPath         string
	UnitSHA256       string
	ExecutablePath   string
	ExecutableSHA256 string
	Argv             []string
	Enabled          bool
	Active           bool
	MainPID          int
	ControlGroup     string
	BootID           string
}

type ArmResult struct {
	Spec  HelperSpec
	Proof HelperProof
}

// RemovalRequest requires evidence from a previously successful Arm/Inspect.
// Remove re-proves the live process when it is active and always re-proves the
// static files immediately before unlinking them.
type RemovalRequest struct {
	Spec          HelperSpec
	ExpectedProof HelperProof
}

type RemovalResult struct {
	UnitRemoved       bool
	ExecutableRemoved bool
}

func helperUnitName(profile identity.Profile, transactionID string) (string, error) {
	if profile != identity.TargetProfile() {
		return "", errors.New("handoff helper requires the canonical target profile")
	}
	if !transactionPattern.MatchString(transactionID) {
		return "", errors.New("handoff helper transaction id is invalid")
	}
	base := strings.TrimSuffix(profile.ManagerUnit, "-manager.service")
	if base == profile.ManagerUnit || base == "" {
		return "", errors.New("target Manager unit cannot derive a handoff helper unit")
	}
	hexID := strings.TrimPrefix(transactionID, "handoff_")
	return fmt.Sprintf("%s-namespace-handoff-%s.service", base, hexID[:12]), nil
}

func validateCanonicalAbsolute(path, label string) error {
	if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return fmt.Errorf("%s must be a canonical absolute path", label)
	}
	if strings.IndexByte(path, 0) >= 0 {
		return fmt.Errorf("%s contains a NUL byte", label)
	}
	return nil
}
