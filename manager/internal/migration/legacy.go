package migration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/atomicfile"
	"github.com/ubitech/agent-platform/manager/internal/driver"
)

type FileRecord struct {
	Path       string `json:"path"`
	Kind       string `json:"kind"`
	Mode       string `json:"mode"`
	Size       int64  `json:"size"`
	SHA256     string `json:"sha256,omitempty"`
	LinkTarget string `json:"link_target,omitempty"`
}

type ArchiveTree struct {
	Name         string `json:"name"`
	OriginalPath string `json:"original_path"`
	ArchivePath  string `json:"archive_path"`
	ManifestPath string `json:"manifest_path"`
	FileCount    int    `json:"file_count"`
	TotalBytes   int64  `json:"total_bytes"`
	Digest       string `json:"digest"`
}

type ArchiveFile struct {
	Name         string     `json:"name"`
	OriginalPath string     `json:"original_path"`
	ArchivePath  string     `json:"archive_path"`
	Record       FileRecord `json:"record"`
}

type ArchiveManifest struct {
	SchemaVersion int          `json:"schema_version"`
	Name          string       `json:"name"`
	OriginalPath  string       `json:"original_path"`
	ArchivePath   string       `json:"archive_path"`
	Status        string       `json:"status"`
	Entries       []FileRecord `json:"entries"`
	FileCount     int          `json:"file_count"`
	TotalBytes    int64        `json:"total_bytes"`
	Digest        string       `json:"digest"`
	UpdatedAt     time.Time    `json:"updated_at"`
}

type ArchiveReceipt struct {
	SchemaVersion   int           `json:"schema_version"`
	OperationID     string        `json:"operation_id"`
	Trees           []ArchiveTree `json:"trees"`
	Files           []ArchiveFile `json:"files,omitempty"`
	ComposeProjects []string      `json:"compose_projects,omitempty"`
	ComposeVolumes  []string      `json:"compose_volumes,omitempty"`
	VerifiedAt      time.Time     `json:"verified_at"`
}

type Plan struct {
	SchemaVersion        int           `json:"schema_version"`
	ID                   string        `json:"id"`
	LegacyRoot           string        `json:"legacy_root"`
	LegacyData           string        `json:"legacy_data"`
	DestinationData      string        `json:"destination_data"`
	LegacyService        string        `json:"legacy_service"`
	ExpectedSourceCommit string        `json:"expected_source_commit,omitempty"`
	OperationID          string        `json:"operation_id,omitempty"`
	Status               string        `json:"status"`
	Copied               bool          `json:"copied"`
	CopyPrepared         bool          `json:"copy_prepared"`
	OldServiceStopped    bool          `json:"old_service_stopped"`
	UnitStateRecorded    bool          `json:"unit_state_recorded"`
	LegacyUnitFileState  string        `json:"legacy_unit_file_state,omitempty"`
	LegacyWasEnabled     bool          `json:"legacy_was_enabled"`
	Entries              []FileRecord  `json:"entries,omitempty"`
	ArchivePath          string        `json:"archive_path,omitempty"`
	ArchiveReady         bool          `json:"archive_ready"`
	ArchiveRestored      bool          `json:"archive_restored"`
	ArchiveTrees         []ArchiveTree `json:"archive_trees,omitempty"`
	ArchiveFiles         []ArchiveFile `json:"archive_files,omitempty"`
	RetiredCaches        []ArchiveTree `json:"retired_caches,omitempty"`
	LegacyUnitPath       string        `json:"legacy_unit_path,omitempty"`
	ComposeProjects      []string      `json:"compose_projects,omitempty"`
	ComposeVolumes       []string      `json:"compose_volumes,omitempty"`
	ComposeCleanupErrors []string      `json:"compose_cleanup_errors,omitempty"`
	Quarantined          []string      `json:"quarantined,omitempty"`
	Error                string        `json:"error,omitempty"`
	CreatedAt            time.Time     `json:"created_at"`
	UpdatedAt            time.Time     `json:"updated_at"`
}

type Service struct {
	StatePath, DestinationData, BackupRoot, QuarantineRoot string
	LegacyService                                          string
	LegacyUnitPath                                         string
	Runner                                                 driver.Runner
	Now                                                    func() time.Time
	ReleaseGateway                                         func()
	BeforePersist                                          func(Plan) error
	BeforeArchiveStep                                      func(string) error
	PreCutoverCheck                                        func(context.Context, Plan) error
	ArchiveRename                                          func(string, string) error
	SyncDir                                                func(string) error
	mutationMu                                             sync.Mutex
	stateMu                                                sync.RWMutex
	stateLoaded                                            bool
	statePlan                                              Plan
	stateErr                                               error
}

func (s *Service) Configure(root, data string, serviceName ...string) (Plan, error) {
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	root, err := cleanRoot(root)
	if err != nil {
		return Plan{}, err
	}
	if data == "" {
		for _, candidate := range []string{filepath.Join(root, "enterprise-agent-platform", "data"), filepath.Join(root, "data")} {
			if info, statErr := os.Stat(candidate); statErr == nil && info.IsDir() {
				data = candidate
				break
			}
		}
	}
	data, err = cleanRoot(data)
	if err != nil {
		return Plan{}, fmt.Errorf("legacy data: %w", err)
	}
	if info, err := os.Stat(data); err != nil || !info.IsDir() {
		return Plan{}, fmt.Errorf("legacy data directory is unavailable")
	}
	destination, err := cleanRoot(s.DestinationData)
	if err != nil {
		return Plan{}, err
	}
	if samePath(destination, root) || isWithin(root, destination) || isWithin(destination, root) {
		return Plan{}, errors.New("destination data and legacy source root must not overlap")
	}
	if !samePath(data, destination) && (isWithin(data, destination) || isWithin(destination, data)) {
		return Plan{}, errors.New("legacy and destination data roots must not overlap")
	}
	legacyService := s.LegacyService
	if len(serviceName) > 0 && serviceName[0] != "" {
		legacyService = serviceName[0]
	}
	if legacyService == "" {
		legacyService = "enterprise-agent-platform.service"
	}
	if !validServiceName(legacyService) {
		return Plan{}, errors.New("legacy service must be a valid systemd .service unit")
	}
	expectedSourceCommit := ""
	if len(serviceName) > 1 {
		expectedSourceCommit = serviceName[1]
	}
	if expectedSourceCommit != "" && !validCommit(expectedSourceCommit) {
		return Plan{}, errors.New("expected source commit must be a 40-character lowercase Git commit")
	}
	id := migrationID(root, data, legacyService)
	if current, loadErr := s.loadLocked(); loadErr == nil {
		if current.ID != id {
			return Plan{}, errors.New("a different legacy migration is already configured")
		}
		if current.ExpectedSourceCommit != expectedSourceCommit {
			return Plan{}, errors.New("legacy migration expected source commit changed")
		}
		if current.Status == "rolled_back" {
			if !samePath(current.LegacyData, current.DestinationData) {
				if err := os.RemoveAll(current.DestinationData); err != nil {
					return Plan{}, fmt.Errorf("remove rolled-back destination: %w", err)
				}
				if err := os.RemoveAll(current.DestinationData + ".migrating-" + current.ID); err != nil {
					return Plan{}, fmt.Errorf("remove rolled-back staging data: %w", err)
				}
			}
			current.Status = "configured"
			current.OperationID = ""
			current.Copied = false
			current.CopyPrepared = false
			current.OldServiceStopped = false
			current.UnitStateRecorded = false
			current.LegacyUnitFileState = ""
			current.LegacyWasEnabled = false
			current.Entries = nil
			current.ArchivePath = ""
			current.ArchiveReady = false
			current.ArchiveTrees = nil
			current.ArchiveFiles = nil
			current.RetiredCaches = nil
			current.ComposeCleanupErrors = nil
			current.Error = ""
			current.UpdatedAt = s.now()
			if err := s.persistLocked(current); err != nil {
				return Plan{}, err
			}
		}
		return current, nil
	} else if !os.IsNotExist(loadErr) {
		return Plan{}, fmt.Errorf("read existing legacy migration: %w", loadErr)
	}
	now := s.now()
	plan := Plan{
		SchemaVersion: 1, ID: id, LegacyRoot: root, LegacyData: data,
		DestinationData: destination, LegacyService: legacyService, ExpectedSourceCommit: expectedSourceCommit,
		LegacyUnitPath: s.legacyUnitPath(legacyService), ComposeProjects: legacyComposeProjects(data),
		Status: "configured", CreatedAt: now, UpdatedAt: now,
	}
	if err := s.persistLocked(plan); err != nil {
		return Plan{}, err
	}
	return plan, nil
}

// Plan returns the latest durable migration state without waiting for a long
// copy, archive, rollback, or prune operation holding mutationMu. The first
// read initializes the snapshot directly from the atomically replaced state
// file; every successful persistence publishes a newer immutable snapshot.
func (s *Service) Plan() (Plan, error) {
	s.stateMu.RLock()
	if s.stateLoaded {
		plan, err := clonePlan(s.statePlan), s.stateErr
		s.stateMu.RUnlock()
		return plan, err
	}
	s.stateMu.RUnlock()

	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	if !s.stateLoaded {
		plan, err := s.loadLocked()
		s.statePlan = clonePlan(plan)
		s.stateErr = err
		s.stateLoaded = true
	}
	return clonePlan(s.statePlan), s.stateErr
}
func (s *Service) Active() bool {
	plan, err := s.Plan()
	if err != nil {
		// Force a corrupt or unreadable durable plan through Cutover so its
		// concrete error is surfaced before install can bypass legacy recovery.
		// A genuinely absent plan is the only inactive error case.
		return !os.IsNotExist(err)
	}
	return plan.Status != "cleanup_pending" && plan.Status != "committed" && plan.Status != "rolled_back"
}

// PreCutover reruns bridge-owned checks at the last reversible point, after
// the global idle reservation but before maintenance or legacy service stop.
func (s *Service) PreCutover(ctx context.Context, operationID string) error {
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	plan, err := s.loadLocked()
	if err != nil {
		return fmt.Errorf("read legacy migration before cutover preflight: %w", err)
	}
	if operationID == "" {
		return errors.New("legacy cutover operation id is required")
	}
	if plan.OperationID != "" && plan.OperationID != operationID {
		return errors.New("legacy cutover belongs to a different operation")
	}
	if plan.Status != "configured" && plan.Status != "failed" {
		return fmt.Errorf("legacy migration is in state %s", plan.Status)
	}
	if s.PreCutoverCheck != nil {
		if err := s.PreCutoverCheck(ctx, plan); err != nil {
			return fmt.Errorf("legacy cutover preflight: %w", err)
		}
	}
	return nil
}

func (s *Service) Cutover(ctx context.Context, operationID string) error {
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	plan, err := s.loadLocked()
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read legacy migration before cutover: %w", err)
	}
	if plan.Status == "migrated" || plan.Status == "committed" {
		return nil
	}
	if plan.Status != "configured" && plan.Status != "failed" {
		return fmt.Errorf("legacy migration is in state %s", plan.Status)
	}
	unitState, err := s.legacyUnitState(ctx, plan.LegacyService)
	if err != nil {
		return err
	}
	plan.Status = "stopping_legacy"
	plan.OperationID = operationID
	plan.UnitStateRecorded = true
	plan.LegacyUnitFileState = unitState
	plan.LegacyWasEnabled = unitState == "enabled" || unitState == "enabled-runtime" || unitState == "linked" || unitState == "linked-runtime"
	plan.Error = ""
	if err = s.update(&plan); err != nil {
		return err
	}
	if _, err = s.runner().Run(ctx, "systemctl", []string{"--user", "disable", "--now", plan.LegacyService}, nil); err != nil {
		return s.startLegacyAfterCutoverFailure(ctx, &plan, fmt.Errorf("disable legacy service for cutover: %w", err))
	}
	plan.OldServiceStopped = true
	plan.Status = "copying"
	if err = s.update(&plan); err != nil {
		return s.startLegacyAfterCutoverFailure(ctx, &plan, fmt.Errorf("persist stopped legacy service state: %w", err))
	}
	if samePath(plan.LegacyData, plan.DestinationData) {
		plan.Copied = false
	} else {
		if err = ensureEmptyDestination(plan.DestinationData); err != nil {
			return s.failCutover(ctx, &plan, err)
		}
		staging := plan.DestinationData + ".migrating-" + plan.ID
		if err = os.RemoveAll(staging); err != nil {
			return s.failCutover(ctx, &plan, err)
		}
		entries, copyErr := copyTree(ctx, plan.LegacyData, staging, s.syncDirectory)
		if copyErr != nil {
			_ = os.RemoveAll(staging)
			return s.failCutover(ctx, &plan, copyErr)
		}
		if err = verifyTree(staging, entries); err != nil {
			_ = os.RemoveAll(staging)
			return s.failCutover(ctx, &plan, err)
		}
		plan.Entries = entries
		plan.CopyPrepared = true
		plan.Status = "installing_copy"
		if err = s.update(&plan); err != nil {
			return s.startLegacyAfterCutoverFailure(ctx, &plan, fmt.Errorf("persist prepared legacy copy: %w", err))
		}
		if err = os.Rename(staging, plan.DestinationData); err != nil {
			return s.failCutover(ctx, &plan, err)
		}
		if err = s.syncDirectory(filepath.Dir(plan.DestinationData)); err != nil {
			return s.startLegacyAfterCutoverFailure(ctx, &plan, fmt.Errorf("sync installed legacy data parent directory: %w", err))
		}
		plan.Copied = true
		plan.CopyPrepared = false
		plan.Status = "copying"
		if err = s.update(&plan); err != nil {
			return s.startLegacyAfterCutoverFailure(ctx, &plan, fmt.Errorf("persist installed legacy copy: %w", err))
		}
	}
	if err = s.backupLegacy(plan, operationID); err != nil {
		return s.failCutover(ctx, &plan, err)
	}
	plan.Status = "migrated"
	plan.UpdatedAt = s.now()
	if err = s.persistLocked(plan); err != nil {
		return s.startLegacyAfterCutoverFailure(ctx, &plan, fmt.Errorf("persist completed legacy migration: %w", err))
	}
	return nil
}

// FinalizeCleanup completes and durably records every source-deployment
// archive, cache retirement, and cleanup action. The caller must retain the
// Platform update reservation until this method returns successfully.
func (s *Service) FinalizeCleanup(ctx context.Context, operationID string) error {
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	plan, err := s.loadLocked()
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read legacy migration before commit: %w", err)
	}
	if plan.Status == "committed" {
		return nil
	}
	if plan.Status != "migrated" && plan.Status != "cleanup_pending" {
		return fmt.Errorf("legacy migration has not completed")
	}
	if operationID == "" {
		operationID = plan.OperationID
	}
	// Crossing this durable boundary means the new Platform generation is the
	// sole source of truth. Cleanup can be retried, but the migration must never
	// become Active again or route a later update through the stopped legacy
	// readiness gate.
	if plan.Status == "migrated" {
		plan.Status = "cleanup_pending"
		plan.ArchivePath = filepath.Join(s.BackupRoot, operationID+"-legacy")
		if plan.LegacyUnitPath == "" {
			plan.LegacyUnitPath = s.legacyUnitPath(plan.LegacyService)
		}
		if len(plan.ComposeProjects) == 0 {
			plan.ComposeProjects = legacyComposeProjects(plan.LegacyData)
		}
		plan.Error = ""
		plan.UpdatedAt = s.now()
		if err = s.persistLocked(plan); err != nil {
			return err
		}
	}
	if _, err = s.runner().Run(ctx, "systemctl", []string{"--user", "disable", "--now", plan.LegacyService}, nil); err != nil {
		return s.cleanupFail(&plan, fmt.Errorf("disable legacy service: %w", err))
	}
	if !plan.ArchiveReady {
		plan.ArchiveTrees, plan.ArchiveFiles, err = s.archiveLegacy(ctx, plan)
		if err != nil {
			return s.cleanupFail(&plan, err)
		}
		plan.RetiredCaches, err = s.retireLegacyCaches(ctx, plan)
		if err != nil {
			return s.cleanupFail(&plan, err)
		}
		plan.ArchiveReady = true
		plan.UpdatedAt = s.now()
		if err = s.persistLocked(plan); err != nil {
			return err
		}
	}
	plan.ComposeCleanupErrors = s.cleanupLegacyCompose(ctx, plan)
	if len(plan.ComposeCleanupErrors) != 0 {
		return s.cleanupFail(&plan, fmt.Errorf("clean up legacy Compose resources: %s", strings.Join(plan.ComposeCleanupErrors, "; ")))
	}
	plan.ComposeCleanupErrors = nil
	plan.Error = ""
	plan.Status = "committed"
	plan.UpdatedAt = s.now()
	if err = s.persistLocked(plan); err != nil {
		return err
	}
	_, _ = s.runner().Run(context.Background(), "systemctl", []string{"--user", "disable", "--now", "ubitech-agent-migrate.timer"}, nil)
	return nil
}

func (s *Service) Rollback(ctx context.Context, operationID string) error {
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	plan, err := s.loadLocked()
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read legacy migration before rollback: %w", err)
	}
	if plan.Status == "cleanup_pending" || plan.Status == "committed" {
		return errors.New("legacy migration is already committed")
	}
	if !samePath(plan.LegacyData, plan.DestinationData) {
		if info, statErr := os.Stat(plan.LegacyData); statErr != nil || !info.IsDir() {
			if statErr == nil {
				statErr = errors.New("legacy data is not a directory")
			}
			return fmt.Errorf("verify legacy data before discarding uncommitted copy: %w", statErr)
		}
		// Destination and staging are never authoritative before Commit. Remove
		// both regardless of result flags: an older Manager, or a power loss
		// between rename and its result write, may have left neither flag set.
		if err = os.RemoveAll(plan.DestinationData); err != nil {
			return err
		}
		if err = os.RemoveAll(plan.DestinationData + ".migrating-" + plan.ID); err != nil {
			return err
		}
	}
	// A persisted stop intent proves systemctl stop may have completed even when
	// power failed before OldServiceStopped could be written. Starting an
	// already-running user service is idempotent, so recovery is conservative.
	if plan.OldServiceStopped || plan.Status != "configured" {
		if s.ReleaseGateway != nil {
			s.ReleaseGateway()
		}
		if err = s.restoreLegacyService(ctx, plan); err != nil {
			return fmt.Errorf("restart legacy service: %w", err)
		}
	}
	plan.Status = "rolled_back"
	plan.Copied = false
	plan.CopyPrepared = false
	plan.OldServiceStopped = false
	plan.UpdatedAt = s.now()
	plan.Error = ""
	return s.persistLocked(plan)
}

func (s *Service) Prune(now time.Time, retention time.Duration) error {
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	if retention <= 0 {
		retention = 7 * 24 * time.Hour
	}
	plan, err := s.loadLocked()
	if os.IsNotExist(err) {
		// Unknown directories are not proof of ownership or commit.
		return nil
	}
	if err != nil {
		return fmt.Errorf("read legacy migration before prune: %w", err)
	}
	if plan.Status != "committed" || !plan.ArchiveReady || plan.ArchivePath == "" {
		return nil
	}
	backupRoot, err := cleanRoot(s.BackupRoot)
	if err != nil {
		return err
	}
	archivePath, err := cleanRoot(plan.ArchivePath)
	if err != nil {
		return err
	}
	if !isWithin(backupRoot, archivePath) || samePath(backupRoot, archivePath) || filepath.Base(archivePath) != plan.OperationID+"-legacy" {
		return errors.New("legacy recovery archive is outside the managed backup root")
	}
	info, err := os.Lstat(archivePath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("legacy recovery archive is not a regular directory")
	}
	if now.Sub(info.ModTime()) <= retention {
		return nil
	}
	if err := verifyRecoveryPack(plan); err != nil {
		return fmt.Errorf("verify legacy recovery archive before prune: %w", err)
	}
	return os.RemoveAll(archivePath)
}

// Restore reconstructs the legacy checkout, external data and unit file from
// the verified retention archive without consuming it. Starting the restored
// service remains an explicit operator decision after the Docker commit point.
func (s *Service) Restore(ctx context.Context, operationID string) error {
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	plan, err := s.loadLocked()
	if err != nil {
		return err
	}
	if !plan.ArchiveReady || plan.ArchivePath == "" {
		return errors.New("legacy recovery archive is not ready")
	}
	if operationID != "" && plan.OperationID != "" && operationID != plan.OperationID {
		return errors.New("legacy recovery archive belongs to a different operation")
	}
	for _, tree := range plan.ArchiveTrees {
		if err := restoreArchivedTree(ctx, tree, plan.ID); err != nil {
			return fmt.Errorf("restore %s: %w", tree.Name, err)
		}
	}
	for _, file := range plan.ArchiveFiles {
		if err := restoreArchivedFile(file); err != nil {
			return fmt.Errorf("restore %s: %w", file.Name, err)
		}
	}
	plan.ArchiveRestored = true
	plan.UpdatedAt = s.now()
	return s.persistLocked(plan)
}

func (s *Service) archiveLegacy(ctx context.Context, plan Plan) ([]ArchiveTree, []ArchiveFile, error) {
	archiveRoot := plan.ArchivePath
	if archiveRoot == "" {
		return nil, nil, errors.New("legacy archive path is missing")
	}
	if samePath(archiveRoot, plan.LegacyRoot) || isWithin(plan.LegacyRoot, archiveRoot) {
		return nil, nil, errors.New("legacy archive must be outside the checkout")
	}
	if isWithin(plan.LegacyData, archiveRoot) || isWithin(plan.DestinationData, archiveRoot) {
		return nil, nil, errors.New("legacy archive must be outside old and new data roots")
	}
	if err := os.MkdirAll(archiveRoot, 0o700); err != nil {
		return nil, nil, err
	}
	trees := make([]ArchiveTree, 0, 2)
	checkout, err := s.archiveTree(ctx, "checkout", plan.LegacyRoot, archiveRoot)
	if err != nil {
		return nil, nil, err
	}
	trees = append(trees, checkout)
	if !samePath(plan.LegacyData, plan.DestinationData) && !isWithin(plan.LegacyRoot, plan.LegacyData) {
		external, archiveErr := s.archiveTree(ctx, "external-data", plan.LegacyData, archiveRoot)
		if archiveErr != nil {
			return nil, nil, archiveErr
		}
		trees = append(trees, external)
	}
	files := make([]ArchiveFile, 0, 1)
	if plan.LegacyUnitPath != "" && !isWithin(plan.LegacyRoot, plan.LegacyUnitPath) {
		unit, found, archiveErr := archiveStandaloneFile(plan.LegacyUnitPath, filepath.Join(archiveRoot, "unit"), "systemd-unit")
		if archiveErr != nil {
			return nil, nil, archiveErr
		}
		if found {
			files = append(files, unit)
		}
	}
	receipt := ArchiveReceipt{1, plan.OperationID, trees, files, append([]string(nil), plan.ComposeProjects...), append([]string(nil), plan.ComposeVolumes...), s.now()}
	if err := atomicfile.WriteJSON(filepath.Join(archiveRoot, "archive-receipt.json"), receipt, 0o600); err != nil {
		return nil, nil, err
	}
	return trees, files, nil
}

func (s *Service) retireLegacyCaches(ctx context.Context, plan Plan) ([]ArchiveTree, error) {
	root := filepath.Join(plan.ArchivePath, "retired-cache")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	result := make([]ArchiveTree, 0)
	for _, candidate := range legacyDisposablePaths(plan.DestinationData) {
		manifestPath := filepath.Join(root, candidate.Name+"-manifest.json")
		info, statErr := os.Lstat(candidate.Path)
		if os.IsNotExist(statErr) {
			if _, manifestErr := os.Stat(manifestPath); os.IsNotExist(manifestErr) {
				continue
			} else if manifestErr != nil {
				return nil, manifestErr
			}
		} else if statErr != nil {
			return nil, statErr
		} else if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("refusing non-directory disposable path %s", candidate.Path)
		}
		archived, err := s.archiveTree(ctx, candidate.Name, candidate.Path, root)
		if err != nil {
			return nil, err
		}
		result = append(result, archived)
	}
	receipt := struct {
		SchemaVersion int           `json:"schema_version"`
		Trees         []ArchiveTree `json:"trees"`
		VerifiedAt    time.Time     `json:"verified_at"`
	}{1, result, s.now()}
	if err := atomicfile.WriteJSON(filepath.Join(root, "receipt.json"), receipt, 0o600); err != nil {
		return nil, err
	}
	return result, nil
}

type disposablePath struct {
	Name string
	Path string
}

func legacyDisposablePaths(dataRoot string) []disposablePath {
	// Deliberately exact and closed. Do not derive additional paths from names
	// found on disk: adjacent directories contain profiles, cookies, sessions,
	// indexes and databases that remain authoritative.
	relative := []string{
		"runtimes/cognee/source",
		"runtimes/firecrawl/source",
		"runtimes/camofox/app",
		"runtimes/camofox/browser",
		"runtimes/camofox/browser.previous",
		"runtimes/node",
	}
	result := make([]disposablePath, 0, len(relative))
	for _, item := range relative {
		result = append(result, disposablePath{Name: "cache-" + strings.NewReplacer("/", "-", ".", "-").Replace(item), Path: filepath.Join(dataRoot, filepath.FromSlash(item))})
	}
	return result
}

func (s *Service) archiveTree(ctx context.Context, name, source, archiveRoot string) (ArchiveTree, error) {
	target := filepath.Join(archiveRoot, name)
	manifestPath := filepath.Join(archiveRoot, name+"-manifest.json")
	var manifest ArchiveManifest
	if err := atomicfile.ReadJSON(manifestPath, &manifest); err != nil {
		if !os.IsNotExist(err) {
			return ArchiveTree{}, err
		}
		entries, scanErr := scanTree(ctx, source)
		if scanErr != nil {
			return ArchiveTree{}, scanErr
		}
		count, total, digest := summarizeEntries(entries)
		manifest = ArchiveManifest{SchemaVersion: 1, Name: name, OriginalPath: source, ArchivePath: target, Status: "prepared", Entries: entries, FileCount: count, TotalBytes: total, Digest: digest, UpdatedAt: s.now()}
		if err := atomicfile.WriteJSON(manifestPath, manifest, 0o600); err != nil {
			return ArchiveTree{}, err
		}
		if err := s.beforeArchive(name + ":prepared"); err != nil {
			return ArchiveTree{}, err
		}
	}
	if manifest.SchemaVersion != 1 || manifest.Name != name || !samePath(manifest.OriginalPath, source) || !samePath(manifest.ArchivePath, target) {
		return ArchiveTree{}, errors.New("legacy archive manifest does not match migration plan")
	}
	if count, total, digest := summarizeEntries(manifest.Entries); count != manifest.FileCount || total != manifest.TotalBytes || digest != manifest.Digest {
		return ArchiveTree{}, errors.New("legacy archive manifest summary is invalid")
	}
	if _, err := os.Stat(target); os.IsNotExist(err) {
		if _, sourceErr := os.Stat(source); sourceErr != nil {
			return ArchiveTree{}, fmt.Errorf("legacy archive source and target are unavailable: %w", sourceErr)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return ArchiveTree{}, err
		}
		renameErr := s.archiveRename(source, target)
		if renameErr != nil && !errors.Is(renameErr, syscall.EXDEV) {
			return ArchiveTree{}, renameErr
		}
		if errors.Is(renameErr, syscall.EXDEV) {
			staging := target + ".staging"
			if err := os.RemoveAll(staging); err != nil {
				return ArchiveTree{}, err
			}
			if _, err := copyTree(ctx, source, staging, s.syncDirectory); err != nil {
				_ = os.RemoveAll(staging)
				return ArchiveTree{}, err
			}
			if err := verifyTree(staging, manifest.Entries); err != nil {
				_ = os.RemoveAll(staging)
				return ArchiveTree{}, err
			}
			if err := os.Rename(staging, target); err != nil {
				return ArchiveTree{}, err
			}
			if err := s.syncDirectory(filepath.Dir(target)); err != nil {
				return ArchiveTree{}, err
			}
		}
		if err := s.beforeArchive(name + ":installed"); err != nil {
			return ArchiveTree{}, err
		}
	} else if err != nil {
		return ArchiveTree{}, err
	}
	if err := verifyTree(target, manifest.Entries); err != nil {
		return ArchiveTree{}, fmt.Errorf("verify archived %s: %w", name, err)
	}
	if _, err := os.Stat(source); err == nil {
		if err := os.RemoveAll(source); err != nil {
			return ArchiveTree{}, err
		}
	} else if !os.IsNotExist(err) {
		return ArchiveTree{}, err
	}
	manifest.Status = "archived"
	manifest.UpdatedAt = s.now()
	if err := atomicfile.WriteJSON(manifestPath, manifest, 0o600); err != nil {
		return ArchiveTree{}, err
	}
	return ArchiveTree{Name: name, OriginalPath: source, ArchivePath: target, ManifestPath: manifestPath, FileCount: manifest.FileCount, TotalBytes: manifest.TotalBytes, Digest: manifest.Digest}, nil
}

func (s *Service) beforeArchive(step string) error {
	if s.BeforeArchiveStep != nil {
		return s.BeforeArchiveStep(step)
	}
	return nil
}

func (s *Service) archiveRename(source, target string) error {
	if s.ArchiveRename != nil {
		return s.ArchiveRename(source, target)
	}
	return os.Rename(source, target)
}

func (s *Service) syncDirectory(path string) error {
	if s.SyncDir != nil {
		return s.SyncDir(path)
	}
	return syncDirectory(path)
}
func (s *Service) backupLegacy(plan Plan, operationID string) error {
	path := filepath.Join(s.BackupRoot, operationID+"-legacy")
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	for _, name := range []string{"platform.db", "platform.db-wal", "platform.db-shm", "bootstrap-admin-password.txt"} {
		source := filepath.Join(plan.LegacyData, name)
		info, err := os.Lstat(source)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			continue
		}
		if _, err := copyRegular(source, filepath.Join(path, name), info.Mode().Perm()); err != nil && !os.IsExist(err) {
			return err
		}
	}
	return atomicfile.WriteJSON(filepath.Join(path, "migration-plan.json"), plan, 0o600)
}
func (s *Service) quarantineIgnored(ctx context.Context, plan Plan, operationID string) ([]string, error) {
	result, err := s.runner().Run(ctx, "git", []string{"-C", plan.LegacyRoot, "ls-files", "--others", "--ignored", "--exclude-standard", "-z"}, nil)
	if err != nil {
		return nil, nil
	}
	items := strings.Split(result.Stdout, "\x00")
	sort.Strings(items)
	moved := make([]string, 0)
	for _, relative := range items {
		if relative == "" || knownDisposable(relative) {
			continue
		}
		source := filepath.Join(plan.LegacyRoot, filepath.Clean(relative))
		if isWithin(plan.LegacyData, source) || !isWithin(plan.LegacyRoot, source) {
			continue
		}
		destination := filepath.Join(s.QuarantineRoot, operationID, filepath.Clean(relative))
		if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
			return moved, err
		}
		if err := os.Rename(source, destination); err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return moved, err
		}
		moved = append(moved, relative)
	}
	return moved, nil
}
func (s *Service) loadLocked() (Plan, error) {
	var plan Plan
	if err := atomicfile.ReadJSON(s.StatePath, &plan); err != nil {
		return Plan{}, err
	}
	if plan.SchemaVersion != 1 {
		return Plan{}, errors.New("unsupported legacy migration schema")
	}
	return plan, nil
}
func (s *Service) persistLocked(plan Plan) error {
	if s.BeforePersist != nil {
		if err := s.BeforePersist(plan); err != nil {
			return err
		}
	}
	if err := atomicfile.WriteJSON(s.StatePath, plan, 0o600); err != nil {
		return err
	}
	s.publishPlan(plan)
	return nil
}

func (s *Service) publishPlan(plan Plan) {
	s.stateMu.Lock()
	s.statePlan = clonePlan(plan)
	s.stateErr = nil
	s.stateLoaded = true
	s.stateMu.Unlock()
}

func clonePlan(plan Plan) Plan {
	plan.Entries = append([]FileRecord(nil), plan.Entries...)
	plan.ArchiveTrees = append([]ArchiveTree(nil), plan.ArchiveTrees...)
	plan.ArchiveFiles = append([]ArchiveFile(nil), plan.ArchiveFiles...)
	plan.RetiredCaches = append([]ArchiveTree(nil), plan.RetiredCaches...)
	plan.ComposeProjects = append([]string(nil), plan.ComposeProjects...)
	plan.ComposeVolumes = append([]string(nil), plan.ComposeVolumes...)
	plan.ComposeCleanupErrors = append([]string(nil), plan.ComposeCleanupErrors...)
	plan.Quarantined = append([]string(nil), plan.Quarantined...)
	return plan
}

func (s *Service) update(plan *Plan) error {
	plan.UpdatedAt = s.now()
	return s.persistLocked(*plan)
}
func (s *Service) startLegacyAfterCutoverFailure(ctx context.Context, plan *Plan, cause error) error {
	if s.ReleaseGateway != nil {
		s.ReleaseGateway()
	}
	startErr := s.restoreLegacyService(ctx, *plan)
	if startErr != nil {
		return fmt.Errorf("%v; restart legacy service: %w", cause, startErr)
	}
	plan.Status = "rolled_back"
	plan.OldServiceStopped = false
	plan.Copied = false
	plan.CopyPrepared = false
	plan.Error = cause.Error()
	plan.UpdatedAt = s.now()
	if persistErr := s.persistLocked(*plan); persistErr != nil {
		// The durable stopping_legacy/copy_prepared record intentionally remains.
		// Startup recovery conservatively starts the already-running service and
		// retries rollback instead of trusting an absent result bit.
		return fmt.Errorf("%v; legacy service restarted but rollback state was not persisted: %w", cause, persistErr)
	}
	return cause
}

func (s *Service) cleanupFail(plan *Plan, err error) error {
	plan.Status = "cleanup_pending"
	plan.Error = err.Error()
	plan.UpdatedAt = s.now()
	if persistErr := s.persistLocked(*plan); persistErr != nil {
		return fmt.Errorf("%v; persist cleanup state: %w", err, persistErr)
	}
	return err
}
func (s *Service) fail(plan *Plan, err error) error {
	plan.Status = "failed"
	plan.Error = err.Error()
	plan.UpdatedAt = s.now()
	if persistErr := s.persistLocked(*plan); persistErr != nil {
		return fmt.Errorf("%v; persist migration failure: %w", err, persistErr)
	}
	return err
}

func (s *Service) failCutover(ctx context.Context, plan *Plan, cause error) error {
	plan.Status = "failed"
	plan.Error = cause.Error()
	plan.UpdatedAt = s.now()
	if persistErr := s.persistLocked(*plan); persistErr != nil {
		return s.startLegacyAfterCutoverFailure(ctx, plan, fmt.Errorf("%v; persist migration failure: %w", cause, persistErr))
	}
	return cause
}
func (s *Service) runner() driver.Runner {
	if s.Runner != nil {
		return s.Runner
	}
	return driver.CommandRunner{}
}

func (s *Service) legacyUnitState(ctx context.Context, serviceName string) (string, error) {
	result, err := s.runner().Run(ctx, "systemctl", []string{"--user", "show", serviceName, "--property=UnitFileState", "--value"}, nil)
	if err != nil {
		return "", fmt.Errorf("read legacy unit state: %w", err)
	}
	state := strings.TrimSpace(result.Stdout)
	switch state {
	case "enabled", "enabled-runtime", "linked", "linked-runtime", "disabled", "static", "indirect", "generated", "transient", "masked", "masked-runtime", "alias":
		return state, nil
	default:
		return "", fmt.Errorf("legacy unit returned unsupported UnitFileState %q", state)
	}
}

func (s *Service) restoreLegacyService(ctx context.Context, plan Plan) error {
	args := []string{"--user", "start", plan.LegacyService}
	if plan.UnitStateRecorded && plan.LegacyWasEnabled {
		args = []string{"--user", "enable", "--now", plan.LegacyService}
	}
	_, err := s.runner().Run(ctx, "systemctl", args, nil)
	return err
}
func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func (s *Service) legacyUnitPath(serviceName string) string {
	if s.LegacyUnitPath != "" {
		return s.LegacyUnitPath
	}
	config, err := os.UserConfigDir()
	if err != nil || config == "" {
		return ""
	}
	return filepath.Join(config, "systemd", "user", serviceName)
}

func legacyComposeProjects(data string) []string {
	targets := legacyComposeTargets(data)
	projects := make([]string, 0, len(targets))
	for _, target := range targets {
		projects = append(projects, target.Project)
	}
	return projects
}

type legacyComposeTarget struct {
	Project     string
	RuntimeRoot string
	Services    map[string]struct{}
}

func legacyComposeTargets(data string) []legacyComposeTarget {
	searxngRoot := filepath.Join(data, "runtimes", "searxng")
	digest := sha256.Sum256([]byte(searxngRoot))
	services := func(names ...string) map[string]struct{} {
		result := make(map[string]struct{}, len(names))
		for _, name := range names {
			result[name] = struct{}{}
		}
		return result
	}
	return []legacyComposeTarget{
		{
			Project:     "firecrawl",
			RuntimeRoot: filepath.Join(data, "runtimes", "firecrawl"),
			Services: services(
				"api",
				"playwright-service",
				"nuq-postgres",
				"redis",
				"rabbitmq",
				"foundationdb",
				"foundationdb-init",
			),
		},
		{
			Project:     "ubitech-searxng-" + hex.EncodeToString(digest[:8]),
			RuntimeRoot: searxngRoot,
			Services:    services("searxng"),
		},
	}
}

func (s *Service) cleanupLegacyCompose(ctx context.Context, plan Plan) []string {
	failures := make([]string, 0)
	targets := legacyComposeTargets(plan.LegacyData)
	targetByProject := make(map[string]legacyComposeTarget, len(targets))
	for _, target := range targets {
		targetByProject[target.Project] = target
	}
	configured := make(map[string]bool, len(plan.ComposeProjects))
	for _, project := range plan.ComposeProjects {
		if configured[project] {
			continue
		}
		configured[project] = true
		if _, ok := targetByProject[project]; !ok || !validComposeProject(project) {
			failures = append(failures, project+": project is outside the exact legacy Compose allowlist")
		}
	}
	for _, target := range targets {
		if !configured[target.Project] {
			failures = append(failures, target.Project+": expected legacy Compose project is missing from the migration plan")
			continue
		}
		// Old bridge releases predate the explicit ownership label. Discover by
		// the exact project, then require every container to also have an allowed
		// service and a Compose working directory under that runtime's data root.
		// This preserves safe cleanup without treating a project-name collision as
		// ownership. Named volumes and other project resources remain untouched.
		result, err := s.runner().Run(ctx, "docker", []string{"ps", "-aq", "--filter", "label=com.docker.compose.project=" + target.Project}, nil)
		if err != nil {
			failures = append(failures, target.Project+": "+err.Error())
			continue
		}
		ids := strings.Fields(result.Stdout)
		for _, id := range ids {
			if !validContainerID(id) {
				failures = append(failures, target.Project+": invalid container id from Docker")
				continue
			}
			inspect, inspectErr := s.runner().Run(ctx, "docker", []string{"inspect", "--format", "{{json .Config.Labels}}", id}, nil)
			if inspectErr != nil {
				failures = append(failures, target.Project+"/"+id+": "+inspectErr.Error())
				continue
			}
			var labels map[string]string
			if err := json.Unmarshal([]byte(strings.TrimSpace(inspect.Stdout)), &labels); err != nil {
				failures = append(failures, target.Project+"/"+id+": invalid Docker label metadata")
				continue
			}
			if err := validateLegacyComposeContainer(target, labels); err != nil {
				failures = append(failures, target.Project+"/"+id+": "+err.Error())
				continue
			}
			if _, err := s.runner().Run(ctx, "docker", []string{"rm", "-f", id}, nil); err != nil {
				failures = append(failures, target.Project+"/"+id+": "+err.Error())
			}
		}
	}
	return failures
}

func validateLegacyComposeContainer(target legacyComposeTarget, labels map[string]string) error {
	if labels["com.docker.compose.project"] != target.Project {
		return errors.New("Compose project metadata does not match the allowlist")
	}
	service := labels["com.docker.compose.service"]
	if _, ok := target.Services[service]; !ok {
		return fmt.Errorf("Compose service %q is outside the fixed allowlist", service)
	}
	if managed, present := labels["org.ubitech.agent.managed"]; present && managed != "true" {
		return errors.New("container carries a conflicting ownership label")
	}
	workingDir := labels["com.docker.compose.project.working_dir"]
	if workingDir == "" || !filepath.IsAbs(workingDir) {
		return errors.New("Compose working directory is missing or not absolute")
	}
	workingDir = filepath.Clean(workingDir)
	runtimeRoot := filepath.Clean(target.RuntimeRoot)
	if !samePath(runtimeRoot, workingDir) && !isWithin(runtimeRoot, workingDir) {
		return errors.New("Compose working directory is outside the legacy runtime data subtree")
	}
	return nil
}

func validComposeProject(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, r := range value {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

func validContainerID(value string) bool {
	if len(value) < 12 || len(value) > 64 {
		return false
	}
	for _, r := range value {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}

func scanTree(ctx context.Context, root string) ([]FileRecord, error) {
	entries := make([]FileRecord, 0)
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if relative == "." {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		record := FileRecord{Path: relative, Mode: ModeRecord(info.Mode()), Size: info.Size()}
		switch {
		case entry.Type()&os.ModeSymlink != 0:
			record.Kind = "symlink"
			record.LinkTarget, err = os.Readlink(path)
		case entry.IsDir():
			record.Kind = "directory"
		case entry.Type().IsRegular():
			record.Kind = "file"
			record.SHA256, err = digestFile(path)
		default:
			return fmt.Errorf("unsupported special file in legacy archive: %s", relative)
		}
		if err == nil {
			entries = append(entries, record)
		}
		return err
	})
	return entries, err
}

func summarizeEntries(entries []FileRecord) (int, int64, string) {
	hash := sha256.New()
	var total int64
	for _, entry := range entries {
		_, _ = fmt.Fprintf(hash, "%s\x00%s\x00%s\x00%d\x00%s\x00%s\n", filepath.ToSlash(entry.Path), entry.Kind, entry.Mode, entry.Size, entry.SHA256, entry.LinkTarget)
		if entry.Kind == "file" {
			total += entry.Size
		}
	}
	return len(entries), total, hex.EncodeToString(hash.Sum(nil))
}

func archiveStandaloneFile(source, archiveDir, name string) (ArchiveFile, bool, error) {
	info, err := os.Lstat(source)
	if os.IsNotExist(err) {
		return ArchiveFile{}, false, nil
	}
	if err != nil {
		return ArchiveFile{}, false, err
	}
	if err := os.MkdirAll(archiveDir, 0o700); err != nil {
		return ArchiveFile{}, false, err
	}
	target := filepath.Join(archiveDir, filepath.Base(source))
	record := FileRecord{Path: filepath.Base(source), Mode: ModeRecord(info.Mode()), Size: info.Size()}
	switch {
	case info.Mode().IsRegular():
		record.Kind = "file"
		record.SHA256, err = digestFile(source)
		if err == nil {
			if _, statErr := os.Lstat(target); os.IsNotExist(statErr) {
				_, err = copyRegular(source, target, info.Mode().Perm())
			} else if statErr != nil {
				err = statErr
			}
		}
	case info.Mode()&os.ModeSymlink != 0:
		record.Kind = "symlink"
		record.LinkTarget, err = os.Readlink(source)
		if err == nil {
			if _, statErr := os.Lstat(target); os.IsNotExist(statErr) {
				err = os.Symlink(record.LinkTarget, target)
			} else if statErr != nil {
				err = statErr
			}
		}
	default:
		return ArchiveFile{}, false, errors.New("legacy unit is neither a regular file nor symlink")
	}
	if err != nil {
		return ArchiveFile{}, false, err
	}
	if err := verifyTree(archiveDir, []FileRecord{record}); err != nil {
		return ArchiveFile{}, false, err
	}
	return ArchiveFile{Name: name, OriginalPath: source, ArchivePath: target, Record: record}, true, nil
}

func restoreArchivedTree(ctx context.Context, tree ArchiveTree, migrationID string) error {
	var manifest ArchiveManifest
	if err := atomicfile.ReadJSON(tree.ManifestPath, &manifest); err != nil {
		return err
	}
	if manifest.Status != "archived" || manifest.Digest != tree.Digest || !samePath(manifest.ArchivePath, tree.ArchivePath) || !samePath(manifest.OriginalPath, tree.OriginalPath) {
		return errors.New("archive tree receipt is not restorable")
	}
	if err := verifyTree(tree.ArchivePath, manifest.Entries); err != nil {
		return err
	}
	if _, err := os.Stat(tree.OriginalPath); err == nil {
		return verifyTree(tree.OriginalPath, manifest.Entries)
	} else if !os.IsNotExist(err) {
		return err
	}
	staging := tree.OriginalPath + ".restoring-" + migrationID
	if err := os.RemoveAll(staging); err != nil {
		return err
	}
	if _, err := copyTree(ctx, tree.ArchivePath, staging, syncDirectory); err != nil {
		_ = os.RemoveAll(staging)
		return err
	}
	if err := verifyTree(staging, manifest.Entries); err != nil {
		_ = os.RemoveAll(staging)
		return err
	}
	if err := os.MkdirAll(filepath.Dir(tree.OriginalPath), 0o700); err != nil {
		return err
	}
	if err := os.Rename(staging, tree.OriginalPath); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(tree.OriginalPath))
}

func verifyRecoveryPack(plan Plan) error {
	root, err := cleanRoot(plan.ArchivePath)
	if err != nil {
		return err
	}
	receiptPath := filepath.Join(root, "archive-receipt.json")
	info, err := os.Lstat(receiptPath)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("archive receipt is not a regular file")
	}
	var receipt ArchiveReceipt
	if err := atomicfile.ReadJSON(receiptPath, &receipt); err != nil {
		return err
	}
	if receipt.SchemaVersion != 1 || receipt.OperationID != plan.OperationID || len(receipt.Trees) != len(plan.ArchiveTrees) || len(receipt.Files) != len(plan.ArchiveFiles) {
		return errors.New("archive receipt does not match the committed migration")
	}
	for index := range plan.ArchiveTrees {
		if receipt.Trees[index] != plan.ArchiveTrees[index] {
			return errors.New("archive receipt tree list changed")
		}
	}
	for index := range plan.ArchiveFiles {
		if receipt.Files[index] != plan.ArchiveFiles[index] {
			return errors.New("archive receipt file list changed")
		}
	}
	for _, tree := range append(append([]ArchiveTree(nil), plan.ArchiveTrees...), plan.RetiredCaches...) {
		if filepath.Base(tree.Name) != tree.Name || tree.Name == "." || tree.Name == ".." {
			return errors.New("archive tree has an invalid name")
		}
		directPath := filepath.Join(root, tree.Name)
		directManifest := filepath.Join(root, tree.Name+"-manifest.json")
		cachePath := filepath.Join(root, "retired-cache", tree.Name)
		cacheManifest := filepath.Join(root, "retired-cache", tree.Name+"-manifest.json")
		if !(samePath(tree.ArchivePath, directPath) && samePath(tree.ManifestPath, directManifest)) && !(samePath(tree.ArchivePath, cachePath) && samePath(tree.ManifestPath, cacheManifest)) {
			return errors.New("archive tree escapes the recovery pack")
		}
		var manifest ArchiveManifest
		if err := atomicfile.ReadJSON(tree.ManifestPath, &manifest); err != nil {
			return err
		}
		count, total, digest := summarizeEntries(manifest.Entries)
		if manifest.SchemaVersion != 1 || manifest.Status != "archived" || manifest.Name != tree.Name || !samePath(manifest.OriginalPath, tree.OriginalPath) || !samePath(manifest.ArchivePath, tree.ArchivePath) || manifest.FileCount != tree.FileCount || manifest.TotalBytes != tree.TotalBytes || manifest.Digest != tree.Digest || count != tree.FileCount || total != tree.TotalBytes || digest != tree.Digest {
			return fmt.Errorf("archive tree %s manifest is invalid", tree.Name)
		}
		if err := verifyTree(tree.ArchivePath, manifest.Entries); err != nil {
			return fmt.Errorf("archive tree %s: %w", tree.Name, err)
		}
	}
	for _, file := range plan.ArchiveFiles {
		if !isWithin(root, file.ArchivePath) || !samePath(file.ArchivePath, filepath.Join(filepath.Dir(file.ArchivePath), file.Record.Path)) {
			return errors.New("archived standalone file escapes the recovery pack")
		}
		if err := verifyTree(filepath.Dir(file.ArchivePath), []FileRecord{file.Record}); err != nil {
			return fmt.Errorf("archived standalone file %s: %w", file.Name, err)
		}
	}
	return nil
}

func restoreArchivedFile(file ArchiveFile) error {
	archiveDir := filepath.Dir(file.ArchivePath)
	if err := verifyTree(archiveDir, []FileRecord{file.Record}); err != nil {
		return err
	}
	if _, err := os.Lstat(file.OriginalPath); err == nil {
		record := file.Record
		record.Path = filepath.Base(file.OriginalPath)
		return verifyTree(filepath.Dir(file.OriginalPath), []FileRecord{record})
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(file.OriginalPath), 0o700); err != nil {
		return err
	}
	switch file.Record.Kind {
	case "file":
		info, err := os.Stat(file.ArchivePath)
		if err != nil {
			return err
		}
		_, err = copyRegular(file.ArchivePath, file.OriginalPath, info.Mode().Perm())
		return err
	case "symlink":
		return os.Symlink(file.Record.LinkTarget, file.OriginalPath)
	default:
		return errors.New("unsupported archived standalone file")
	}
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func copyTree(ctx context.Context, source, destination string, syncDir func(string) error) ([]FileRecord, error) {
	entries := make([]FileRecord, 0)
	directories := make([]string, 0)
	if syncDir == nil {
		return nil, errors.New("directory sync function is required")
	}
	err := filepath.WalkDir(source, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		if relative == "." {
			if err := os.MkdirAll(destination, 0o700); err != nil {
				return err
			}
			directories = append(directories, destination)
			return nil
		}
		target := filepath.Join(destination, relative)
		info, err := entry.Info()
		if err != nil {
			return err
		}
		record := FileRecord{Path: relative, Mode: ModeRecord(info.Mode()), Size: info.Size()}
		switch {
		case entry.Type()&os.ModeSymlink != 0:
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			if err = os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
				return err
			}
			if err = os.Symlink(link, target); err != nil {
				return err
			}
			record.Kind = "symlink"
			record.LinkTarget = link
		case entry.IsDir():
			if err = os.MkdirAll(target, info.Mode().Perm()); err != nil {
				return err
			}
			if err = os.Chmod(target, info.Mode().Perm()); err != nil {
				return err
			}
			record.Kind = "directory"
			directories = append(directories, target)
		case entry.Type().IsRegular():
			digest, err := copyRegular(path, target, info.Mode().Perm())
			if err != nil {
				return err
			}
			record.Kind = "file"
			record.SHA256 = digest
		default:
			return fmt.Errorf("unsupported special file in legacy data: %s", relative)
		}
		entries = append(entries, record)
		return nil
	})
	if err != nil {
		return entries, err
	}
	// Persist directory entries after all ordinary files have been synced. WalkDir
	// visits parents before children, so reversing the collected order provides
	// the required leaf-to-root durability barrier for the complete staging tree.
	for index := len(directories) - 1; index >= 0; index-- {
		select {
		case <-ctx.Done():
			return entries, ctx.Err()
		default:
		}
		if err := syncDir(directories[index]); err != nil {
			return entries, fmt.Errorf("sync copied directory %s: %w", directories[index], err)
		}
	}
	return entries, nil
}
func verifyTree(root string, entries []FileRecord) error {
	for _, entry := range entries {
		path := filepath.Join(root, entry.Path)
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if entry.Kind != "symlink" && ModeRecord(info.Mode()) != entry.Mode {
			return fmt.Errorf("mode verification failed for %s", entry.Path)
		}
		switch entry.Kind {
		case "directory":
			if !info.IsDir() {
				return fmt.Errorf("verification failed for %s", entry.Path)
			}
		case "symlink":
			target, err := os.Readlink(path)
			if err != nil || target != entry.LinkTarget {
				return fmt.Errorf("verification failed for %s", entry.Path)
			}
		case "file":
			if info.Size() != entry.Size {
				return fmt.Errorf("size verification failed for %s", entry.Path)
			}
			digest, err := digestFile(path)
			if err != nil || digest != entry.SHA256 {
				return fmt.Errorf("verification failed for %s", entry.Path)
			}
		}
	}
	return nil
}
func copyRegular(source, destination string, mode os.FileMode) (string, error) {
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return "", err
	}
	input, err := os.Open(source)
	if err != nil {
		return "", err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return "", err
	}
	hash := sha256.New()
	_, copyErr := io.Copy(io.MultiWriter(output, hash), input)
	chmodErr := output.Chmod(mode.Perm())
	syncErr := output.Sync()
	closeErr := output.Close()
	if copyErr != nil {
		return "", copyErr
	}
	if chmodErr != nil {
		return "", chmodErr
	}
	if syncErr != nil {
		return "", syncErr
	}
	if closeErr != nil {
		return "", closeErr
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
func digestFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
func cleanRoot(path string) (string, error) {
	if path == "" {
		return "", errors.New("path is required")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	absolute = filepath.Clean(absolute)
	if absolute == "/" || absolute == "." {
		return "", errors.New("refusing unsafe root path")
	}
	return absolute, nil
}
func ensureEmptyDestination(path string) error {
	entries, err := os.ReadDir(path)
	if os.IsNotExist(err) {
		return os.MkdirAll(filepath.Dir(path), 0o700)
	}
	if err != nil {
		return err
	}
	if len(entries) > 0 {
		err = filepath.WalkDir(path, func(current string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() {
				return nil
			}
			relative, _ := filepath.Rel(path, current)
			if filepath.ToSlash(relative) == "runtimes/searxng/config/settings.yml" && entry.Type().IsRegular() {
				return nil
			}
			return errors.New("destination data directory contains non-scaffold data")
		})
		if err != nil {
			return err
		}
	}
	return os.RemoveAll(path)
}
func samePath(a, b string) bool {
	aa, _ := filepath.Abs(a)
	bb, _ := filepath.Abs(b)
	return filepath.Clean(aa) == filepath.Clean(bb)
}
func isWithin(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
func migrationID(root, data, service string) string {
	sum := sha256.Sum256([]byte(root + "\x00" + data + "\x00" + service))
	return "legacy-" + hex.EncodeToString(sum[:8])
}
func validServiceName(value string) bool {
	if !strings.HasSuffix(value, ".service") || len(value) > 200 {
		return false
	}
	for _, r := range value {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-' || r == '@' || r == ':') {
			return false
		}
	}
	return true
}
func validCommit(value string) bool {
	if len(value) != 40 {
		return false
	}
	for _, r := range value {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}
func knownDisposable(path string) bool {
	first := strings.Split(filepath.ToSlash(path), "/")[0]
	switch first {
	case ".git", ".venv", "node_modules", "__pycache__", "dist", "build", "static":
		return true
	}
	return false
}
func ModeRecord(mode os.FileMode) string { return mode.String() }
