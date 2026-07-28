package migration

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/journal"
)

const sourceRetirementCampaign = "source-v1-retirement-2026-07"

var sourceRetirementCutoff = time.Date(2026, time.July, 29, 0, 0, 0, 0, time.UTC)

var (
	recoveryManagerPattern          = regexp.MustCompile(`^ubitech-manager-[0-9a-f]{64}$`)
	recoveryGuardPattern            = regexp.MustCompile(`^source-(transition|rollback)-[A-Za-z0-9_.-]+\.(py|unit)$`)
	recoveryIncomingPattern         = regexp.MustCompile(`^\.ubitech-manager\.incoming\.[A-Za-z0-9]+$`)
	recoveryDownloadPattern         = regexp.MustCompile(`^\.download\.[A-Za-z0-9]{6,32}$`)
	recoveryDownloadManagerPattern  = regexp.MustCompile(`^(ubitech-manager(-linux-(amd64|arm64))?|manager)$`)
	recoveryDownloadChecksumPattern = regexp.MustCompile(`^(ubitech-manager(-linux-(amd64|arm64))?|manager)\.sha256$`)
)

const (
	maxRecoveryDownloadEntries = 8
	maxRecoveryDownloadBytes   = int64(512 << 20)
)

// Retire removes the closed allowlist of source-deployment artifacts after a
// committed container generation has independently proved that it is healthy.
// It is intentionally a background campaign: failures remain visible in the
// migration receipt and are retried without putting the live product back into
// maintenance.
func (s *Service) Retire(ctx context.Context) error {
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()

	plan, err := s.loadLocked()
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read legacy migration before retirement: %w", err)
	}
	if plan.Status == "purged" {
		return nil
	}
	if plan.Status != "committed" || !plan.ArchiveReady || plan.ArchiveRestored {
		return nil
	}
	if plan.CreatedAt.IsZero() || !plan.CreatedAt.Before(sourceRetirementCutoff) {
		return nil
	}
	if err := s.validateRetirementPlan(plan); err != nil {
		return fmt.Errorf("validate source retirement plan: %w", err)
	}
	if plan.Retirement != nil {
		if plan.Retirement.CampaignID != sourceRetirementCampaign {
			return fmt.Errorf("source retirement belongs to unsupported campaign %q", plan.Retirement.CampaignID)
		}
		if err := validateRetirementCheckpoint(*plan.Retirement); err != nil {
			return fmt.Errorf("validate source retirement checkpoint: %w", err)
		}
	}
	if s.RetirementReady == nil {
		return s.retirementWait(&plan, errors.New("source retirement readiness probe is not configured"))
	}
	generationID, err := s.RetirementReady(ctx)
	if err != nil {
		return s.retirementWait(&plan, fmt.Errorf("source retirement readiness: %w", err))
	}
	if strings.TrimSpace(generationID) == "" {
		return s.retirementWait(&plan, errors.New("source retirement readiness returned an empty generation"))
	}

	if plan.Retirement == nil || plan.Retirement.Status == "waiting_readiness" {
		// The verified recovery pack is the proof authorizing the irreversible
		// transition. Persist intent before deleting even one source artifact.
		if err := s.verifyRetirementArchive(plan, false); err != nil {
			return s.retirementWait(&plan, fmt.Errorf("verify source recovery pack before retirement intent: %w", err))
		}
		startedAt := s.now()
		if plan.Retirement != nil {
			startedAt = plan.Retirement.StartedAt
		}
		plan.Retirement = &Retirement{
			CampaignID:   sourceRetirementCampaign,
			GenerationID: generationID,
			Status:       "prepared",
			StartedAt:    startedAt,
		}
		plan.Error = ""
		if err := s.update(&plan); err != nil {
			return fmt.Errorf("persist source retirement intent: %w", err)
		}
	}

	if !plan.Retirement.SystemdRemoved {
		if err := s.removeLegacySystemd(ctx, plan); err != nil {
			return s.retirementFail(&plan, "remove legacy systemd artifacts", err)
		}
		plan.Retirement.SystemdRemoved = true
		plan.Retirement.Status = "systemd_removed"
		if err := s.persistRetirementCheckpoint(&plan); err != nil {
			return err
		}
	}
	if !plan.Retirement.SourceStateRemoved {
		if s.RetireConfig == nil {
			return s.retirementFail(&plan, "retire legacy Manager configuration", errors.New("configuration retirement is not configured"))
		}
		if err := s.RetireConfig(); err != nil {
			return s.retirementFail(&plan, "retire legacy Manager configuration", err)
		}
		if err := s.removeSourceControlArtifacts(plan); err != nil {
			return s.retirementFail(&plan, "remove source control artifacts", err)
		}
		if err := s.removeSourceDataArtifacts(plan); err != nil {
			return s.retirementFail(&plan, "remove source data artifacts", err)
		}
		plan.Retirement.SourceStateRemoved = true
		plan.Retirement.Status = "source_state_removed"
		if err := s.persistRetirementCheckpoint(&plan); err != nil {
			return err
		}
	}
	if !plan.Retirement.DockerRemoved {
		if failures := s.cleanupLegacyCompose(ctx, plan); len(failures) != 0 {
			return s.retirementFail(&plan, "remove legacy Compose containers", errors.New(strings.Join(failures, "; ")))
		}
		if err := s.removeLegacyComposeStorage(ctx, plan); err != nil {
			return s.retirementFail(&plan, "remove legacy Compose storage", err)
		}
		plan.Retirement.DockerRemoved = true
		plan.Retirement.Status = "docker_removed"
		if err := s.persistRetirementCheckpoint(&plan); err != nil {
			return err
		}
	}
	if !plan.Retirement.RecoveryRemoved {
		if err := s.verifyRetirementArchive(plan, true); err != nil {
			return s.retirementFail(&plan, "verify source recovery pack before removal", err)
		}
		if err := s.removeSupersededAttemptPacks(plan); err != nil {
			return s.retirementFail(&plan, "remove superseded source recovery packs", err)
		}
		if err := removeOwnedTree(s.BackupRoot, plan.ArchivePath, s.syncDirectory); err != nil {
			return s.retirementFail(&plan, "remove source recovery pack", err)
		}
		plan.Retirement.RecoveryRemoved = true
		plan.Retirement.Status = "recovery_removed"
		if err := s.persistRetirementCheckpoint(&plan); err != nil {
			return err
		}
	}

	completed := *plan.Retirement
	completed.Status = "completed"
	completed.CompletedAt = s.now()
	completed.Error = ""
	// Compact the detailed plan only after every destructive result is durable.
	// The tombstone prevents source migration from becoming active again without
	// retaining obsolete host paths or a restorable legacy service description.
	tombstone := Plan{
		SchemaVersion:        1,
		ID:                   plan.ID,
		ExpectedSourceCommit: plan.ExpectedSourceCommit,
		OperationID:          plan.OperationID,
		Status:               "purged",
		Retirement:           &completed,
		CreatedAt:            plan.CreatedAt,
		UpdatedAt:            completed.CompletedAt,
	}
	if err := s.persistLocked(tombstone); err != nil {
		return fmt.Errorf("persist source retirement receipt: %w", err)
	}
	return nil
}

func validateRetirementCheckpoint(retirement Retirement) error {
	if retirement.StartedAt.IsZero() {
		return errors.New("retirement identity is incomplete")
	}
	want := map[string][4]bool{
		"waiting_readiness":    {false, false, false, false},
		"prepared":             {false, false, false, false},
		"systemd_removed":      {true, false, false, false},
		"source_state_removed": {true, true, false, false},
		"docker_removed":       {true, true, true, false},
		"recovery_removed":     {true, true, true, true},
	}
	expected, ok := want[retirement.Status]
	if !ok {
		return fmt.Errorf("unsupported retirement status %q", retirement.Status)
	}
	actual := [4]bool{retirement.SystemdRemoved, retirement.SourceStateRemoved, retirement.DockerRemoved, retirement.RecoveryRemoved}
	if actual != expected {
		return errors.New("retirement status and durable result bits disagree")
	}
	if retirement.Status == "waiting_readiness" {
		if strings.TrimSpace(retirement.GenerationID) != "" {
			return errors.New("retirement waiting for readiness already has a generation")
		}
		if strings.TrimSpace(retirement.Error) == "" {
			return errors.New("retirement waiting for readiness has no diagnostic")
		}
	} else if strings.TrimSpace(retirement.GenerationID) == "" {
		return errors.New("retirement identity is incomplete")
	}
	if !retirement.CompletedAt.IsZero() {
		return errors.New("incomplete retirement has a completion timestamp")
	}
	return nil
}

// retirementWait makes a precondition failure observable without crossing the
// irreversible intent boundary. Once intent is prepared, it records only the
// latest diagnostic and preserves every durable cleanup result bit.
func (s *Service) retirementWait(plan *Plan, cause error) error {
	diagnostic := journal.BoundDiagnostic(cause.Error())
	if plan.Retirement != nil && plan.Retirement.Error == diagnostic && plan.Error == diagnostic {
		return cause
	}
	if plan.Retirement == nil {
		plan.Retirement = &Retirement{
			CampaignID: sourceRetirementCampaign,
			Status:     "waiting_readiness",
			StartedAt:  s.now(),
		}
	}
	plan.Retirement.Error = diagnostic
	plan.Error = diagnostic
	plan.UpdatedAt = s.now()
	if persistErr := s.persistLocked(*plan); persistErr != nil {
		return fmt.Errorf("%v; persist source retirement readiness: %w", cause, persistErr)
	}
	return cause
}

func validatePurgedPlan(plan Plan) error {
	if plan.ID == "" || !validCommit(plan.ExpectedSourceCommit) || strings.TrimSpace(plan.OperationID) == "" {
		return errors.New("purged migration identity is incomplete")
	}
	if plan.Retirement == nil || plan.Retirement.CampaignID != sourceRetirementCampaign || plan.Retirement.Status != "completed" {
		return errors.New("completed retirement receipt is missing")
	}
	retirement := plan.Retirement
	if strings.TrimSpace(retirement.GenerationID) == "" || retirement.StartedAt.IsZero() || retirement.CompletedAt.IsZero() || retirement.CompletedAt.Before(retirement.StartedAt) {
		return errors.New("completed retirement timing or generation is invalid")
	}
	if !retirement.SystemdRemoved || !retirement.SourceStateRemoved || !retirement.DockerRemoved || !retirement.RecoveryRemoved {
		return errors.New("completed retirement result bits are incomplete")
	}
	if retirement.Error != "" || plan.Error != "" {
		return errors.New("completed retirement retains an error")
	}
	if plan.LegacyRoot != "" || plan.LegacyData != "" || plan.DestinationData != "" || plan.LegacyService != "" ||
		plan.ArchivePath != "" || plan.LegacyUnitPath != "" || len(plan.Entries) != 0 || len(plan.ArchiveTrees) != 0 ||
		len(plan.ArchiveFiles) != 0 || len(plan.RetiredCaches) != 0 || len(plan.ComposeProjects) != 0 ||
		len(plan.ComposeVolumes) != 0 || len(plan.ComposeCleanupErrors) != 0 || len(plan.Quarantined) != 0 {
		return errors.New("purged retirement receipt retains legacy paths or inventory")
	}
	return nil
}

func (s *Service) validateRetirementPlan(plan Plan) error {
	if plan.ID == "" || !validCommit(plan.ExpectedSourceCommit) || strings.TrimSpace(plan.OperationID) == "" {
		return errors.New("committed migration identity is incomplete")
	}
	legacyRoot, err := cleanRoot(plan.LegacyRoot)
	if err != nil {
		return fmt.Errorf("legacy root: %w", err)
	}
	legacyData, err := cleanRoot(plan.LegacyData)
	if err != nil {
		return fmt.Errorf("legacy data: %w", err)
	}
	destination, err := cleanRoot(s.DestinationData)
	if err != nil {
		return fmt.Errorf("destination data: %w", err)
	}
	stateRoot, err := cleanRoot(filepath.Dir(s.StatePath))
	if err != nil {
		return fmt.Errorf("Manager state root: %w", err)
	}
	for _, old := range []string{legacyRoot, legacyData} {
		for _, current := range []string{destination, stateRoot} {
			if samePath(old, current) || isWithin(old, current) || isWithin(current, old) {
				return errors.New("legacy and current authoritative paths overlap")
			}
		}
	}
	backupRoot, err := cleanRoot(s.BackupRoot)
	if err != nil {
		return fmt.Errorf("backup root: %w", err)
	}
	archive, err := cleanRoot(plan.ArchivePath)
	if err != nil {
		return fmt.Errorf("recovery pack: %w", err)
	}
	if !isWithin(backupRoot, archive) || samePath(backupRoot, archive) || filepath.Base(archive) != plan.OperationID+"-legacy" {
		return errors.New("source recovery pack is outside the exact managed path")
	}
	return nil
}

func (s *Service) verifyRetirementArchive(plan Plan, allowMissing bool) error {
	info, err := os.Lstat(plan.ArchivePath)
	if os.IsNotExist(err) && allowMissing && plan.Retirement != nil {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("source recovery pack is not a regular directory")
	}
	if err := requireOwned(plan.ArchivePath, info); err != nil {
		return err
	}
	return verifyRecoveryPack(plan)
}

// removeSupersededAttemptPacks removes only the small recovery packs produced
// by backupLegacy for an earlier attempt of this exact migration. Directory
// names alone are never ownership proof: the embedded plan, source identity,
// and closed file vocabulary must all agree before a candidate is removed.
func (s *Service) removeSupersededAttemptPacks(plan Plan) error {
	backupRoot, err := cleanRoot(s.BackupRoot)
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(backupRoot)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	currentArchive, err := cleanRoot(plan.ArchivePath)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, "-legacy") || name == "-legacy" {
			continue
		}
		candidate := filepath.Join(backupRoot, name)
		if samePath(candidate, currentArchive) {
			continue
		}
		owned, inspectErr := isSupersededAttemptPack(plan, candidate, strings.TrimSuffix(name, "-legacy"))
		if inspectErr != nil {
			return fmt.Errorf("inspect possible superseded source recovery pack %s: %w", name, inspectErr)
		}
		if !owned {
			// A malformed, foreign, or extended directory is not proof of
			// ownership. Preserve it rather than broadening cleanup.
			continue
		}
		if err := removeOwnedTree(backupRoot, candidate, s.syncDirectory); err != nil {
			return err
		}
	}
	return nil
}

func isSupersededAttemptPack(current Plan, path, operationID string) (bool, error) {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return false, nil
	}
	if err := requireOwned(path, info); err != nil {
		return false, nil
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return false, err
	}
	allowed := map[string]bool{
		"platform.db":                  true,
		"platform.db-wal":              true,
		"platform.db-shm":              true,
		"bootstrap-admin-password.txt": true,
		"migration-plan.json":          true,
	}
	for _, entry := range entries {
		if !allowed[entry.Name()] {
			return false, nil
		}
		entryPath := filepath.Join(path, entry.Name())
		entryInfo, err := os.Lstat(entryPath)
		if err != nil {
			return false, err
		}
		if !entryInfo.Mode().IsRegular() || entryInfo.Mode()&os.ModeSymlink != 0 {
			return false, nil
		}
		if err := requireOwned(entryPath, entryInfo); err != nil {
			return false, nil
		}
	}
	manifestPath := filepath.Join(path, "migration-plan.json")
	manifestInfo, err := os.Lstat(manifestPath)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if manifestInfo.Size() > 8<<20 {
		return false, nil
	}
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return false, err
	}
	var candidate Plan
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&candidate); err != nil {
		return false, nil
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return false, nil
	}
	if operationID == "" || operationID == current.OperationID || candidate.OperationID != operationID ||
		candidate.SchemaVersion != 1 || candidate.Status != "copying" || candidate.ID != current.ID ||
		candidate.ID != migrationID(candidate.LegacyRoot, candidate.LegacyData, candidate.LegacyService) ||
		candidate.ExpectedSourceCommit != current.ExpectedSourceCommit || candidate.LegacyService != current.LegacyService ||
		!samePath(candidate.LegacyRoot, current.LegacyRoot) || !samePath(candidate.LegacyData, current.LegacyData) ||
		!samePath(candidate.DestinationData, current.DestinationData) || !samePath(candidate.LegacyUnitPath, current.LegacyUnitPath) ||
		!candidate.CreatedAt.Equal(current.CreatedAt) || candidate.ArchivePath != "" || candidate.ArchiveReady ||
		candidate.ArchiveRestored || candidate.Retirement != nil || len(candidate.ArchiveTrees) != 0 ||
		len(candidate.ArchiveFiles) != 0 || len(candidate.RetiredCaches) != 0 {
		return false, nil
	}
	return true, nil
}

func (s *Service) persistRetirementCheckpoint(plan *Plan) error {
	plan.Retirement.Error = ""
	plan.Error = ""
	plan.UpdatedAt = s.now()
	if err := s.persistLocked(*plan); err != nil {
		return fmt.Errorf("persist source retirement checkpoint %s: %w", plan.Retirement.Status, err)
	}
	return nil
}

func (s *Service) retirementFail(plan *Plan, step string, cause error) error {
	err := fmt.Errorf("%s: %w", step, cause)
	plan.Retirement.Error = journal.BoundDiagnostic(err.Error())
	plan.Error = plan.Retirement.Error
	plan.UpdatedAt = s.now()
	if persistErr := s.persistLocked(*plan); persistErr != nil {
		return fmt.Errorf("%v; persist source retirement error: %w", err, persistErr)
	}
	return err
}

func (s *Service) removeLegacySystemd(ctx context.Context, plan Plan) error {
	for _, unit := range []string{plan.LegacyService, "ubitech-agent-migrate.timer", "ubitech-agent-migrate.service"} {
		_, _ = s.runner().Run(ctx, "systemctl", []string{"--user", "disable", "--now", unit}, nil)
		result, err := s.runner().Run(ctx, "systemctl", []string{"--user", "is-active", unit}, nil)
		if err == nil {
			return fmt.Errorf("systemd unit %s is still active", unit)
		}
		if result.ExitCode != 3 && result.ExitCode != 4 {
			return fmt.Errorf("confirm systemd unit %s inactive: %w", unit, err)
		}
	}
	guards, err := s.runner().Run(ctx, "systemctl", []string{
		"--user", "list-units", "--type=service", "--state=active", "--no-legend",
		"ubitech-agent-source-transition-*.service", "ubitech-agent-source-rollback-*.service",
	}, nil)
	if err != nil {
		return fmt.Errorf("inspect source migration recovery guards: %w", err)
	}
	if strings.TrimSpace(guards.Stdout) != "" {
		return errors.New("source migration recovery guard is still active")
	}
	unitPath := plan.LegacyUnitPath
	if unitPath == "" {
		unitPath = s.legacyUnitPath(plan.LegacyService)
	}
	if unitPath == "" || filepath.Base(unitPath) != plan.LegacyService {
		return errors.New("legacy systemd unit path is invalid")
	}
	if err := removeArchivedUnit(plan, unitPath, s.syncDirectory); err != nil {
		return err
	}
	unitDir := filepath.Dir(unitPath)
	for _, name := range []string{"ubitech-agent-migrate.service", "ubitech-agent-migrate.timer"} {
		if err := removeOwnedRegular(unitDir, filepath.Join(unitDir, name), 1<<20, s.syncDirectory); err != nil {
			return err
		}
	}
	if err := removeKnownPrefixedFiles(unitDir, []string{
		".ubitech-agent-migrate.service.",
		".ubitech-agent-migrate.timer.",
		"." + plan.LegacyService + ".bridge-recovery-",
		"." + plan.LegacyService + ".transition-restore-",
	}, 1<<20, s.syncDirectory); err != nil {
		return err
	}
	if err := removeExpectedUnitLink(filepath.Join(unitDir, "default.target.wants", plan.LegacyService), unitPath, s.syncDirectory); err != nil {
		return err
	}
	if err := removeExpectedUnitLink(filepath.Join(unitDir, "timers.target.wants", "ubitech-agent-migrate.timer"), filepath.Join(unitDir, "ubitech-agent-migrate.timer"), s.syncDirectory); err != nil {
		return err
	}
	if _, err := s.runner().Run(ctx, "systemctl", []string{"--user", "daemon-reload"}, nil); err != nil {
		return fmt.Errorf("reload user systemd after source retirement: %w", err)
	}
	return nil
}

func removeArchivedUnit(plan Plan, path string, syncDir func(string) error) error {
	if err := verifyManagedPath(filepath.Dir(path), path); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := requireOwned(path, info); err != nil {
		return err
	}
	var archived *ArchiveFile
	for index := range plan.ArchiveFiles {
		if samePath(plan.ArchiveFiles[index].OriginalPath, path) {
			archived = &plan.ArchiveFiles[index]
			break
		}
	}
	if archived == nil {
		return errors.New("legacy systemd unit exists without an archive identity")
	}
	record := archived.Record
	record.Path = filepath.Base(path)
	if err := verifyTree(filepath.Dir(path), []FileRecord{record}); err != nil {
		return fmt.Errorf("legacy systemd unit changed after migration: %w", err)
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	return syncDir(filepath.Dir(path))
}

func (s *Service) removeSourceControlArtifacts(plan Plan) error {
	stateRoot := filepath.Dir(s.StatePath)
	controlRoot := filepath.Join(stateRoot, "control")
	for _, name := range []string{"retry-source-migration.sh", "retry-install-source-migration.sh", "install-source-migration.sh"} {
		if err := removeOwnedRegular(controlRoot, filepath.Join(controlRoot, name), 8<<20, s.syncDirectory); err != nil {
			return err
		}
	}
	if err := removeKnownPrefixedFiles(controlRoot, []string{".retry-source-migration.", ".retry-install-source-migration.", ".install-source-migration."}, 8<<20, s.syncDirectory); err != nil {
		return err
	}
	recoveryRoot := filepath.Join(stateRoot, "recovery")
	entries, err := os.ReadDir(recoveryRoot)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	rootInfo, err := os.Lstat(recoveryRoot)
	if err != nil {
		return err
	}
	if !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("source recovery root is not a regular directory")
	}
	if err := requireOwned(recoveryRoot, rootInfo); err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		if recoveryDownloadPattern.MatchString(name) {
			if err := removeRecoveryDownloadStaging(recoveryRoot, filepath.Join(recoveryRoot, name), s.syncDirectory); err != nil {
				return err
			}
			continue
		}
		if !recoveryManagerPattern.MatchString(name) && !recoveryGuardPattern.MatchString(name) && !recoveryIncomingPattern.MatchString(name) {
			return fmt.Errorf("unknown file in source recovery root: %s", name)
		}
		if err := removeOwnedRegular(recoveryRoot, filepath.Join(recoveryRoot, name), 256<<20, s.syncDirectory); err != nil {
			return err
		}
	}
	if err := os.Remove(recoveryRoot); err != nil && !os.IsNotExist(err) {
		return err
	}
	return s.syncDirectory(stateRoot)
}

func removeRecoveryDownloadStaging(root, path string, syncDir func(string) error) error {
	if err := verifyManagedPath(root, path); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
		return errors.New("recovery download staging is not an owner-only regular directory")
	}
	if err := requireOwned(path, info); err != nil {
		return err
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return err
	}
	if len(entries) > maxRecoveryDownloadEntries {
		return fmt.Errorf("recovery download staging exceeds %d entries", maxRecoveryDownloadEntries)
	}
	var total int64
	for _, entry := range entries {
		entryPath := filepath.Join(path, entry.Name())
		entryInfo, err := os.Lstat(entryPath)
		if err != nil {
			return err
		}
		if !entryInfo.Mode().IsRegular() || entryInfo.Mode()&os.ModeSymlink != 0 || entryInfo.Mode().Perm()&0o077 != 0 {
			return fmt.Errorf("recovery download artifact %s is not an owner-only regular file", entry.Name())
		}
		if err := requireOwned(entryPath, entryInfo); err != nil {
			return err
		}
		if entryInfo.Size() < 0 || entryInfo.Size() > maxRecoveryDownloadBytes-total {
			return fmt.Errorf("recovery download staging exceeds %d-byte limit", maxRecoveryDownloadBytes)
		}
		total += entryInfo.Size()
		if err := validateRecoveryDownloadArtifact(entryPath, entry.Name(), entryInfo.Size()); err != nil {
			return err
		}
	}
	// Delete only the files proven above, then remove the now-empty directory.
	// Avoid RemoveAll so a concurrently introduced nested object cannot be
	// swept up by the legacy compatibility rule.
	for _, entry := range entries {
		if err := removeOwnedRegular(path, filepath.Join(path, entry.Name()), maxRecoveryDownloadBytes, syncDir); err != nil {
			return err
		}
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return syncDir(root)
}

func validateRecoveryDownloadArtifact(path, name string, size int64) error {
	switch {
	case recoveryDownloadManagerPattern.MatchString(name):
		if size < 4 || size > 256<<20 {
			return fmt.Errorf("recovery Manager artifact %s has an invalid size", name)
		}
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		var magic [4]byte
		_, readErr := io.ReadFull(file, magic[:])
		closeErr := file.Close()
		if readErr != nil {
			return readErr
		}
		if closeErr != nil {
			return closeErr
		}
		if magic != [4]byte{0x7f, 'E', 'L', 'F'} {
			return fmt.Errorf("recovery Manager artifact %s is not an ELF binary", name)
		}
		return nil
	case recoveryDownloadChecksumPattern.MatchString(name):
		if size <= 0 || size > 4096 {
			return fmt.Errorf("recovery checksum artifact %s has an invalid size", name)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		fields := strings.Fields(string(data))
		if len(fields) < 1 || len(fields) > 2 || len(fields[0]) != 64 {
			return fmt.Errorf("recovery checksum artifact %s is invalid", name)
		}
		if _, err := strconv.ParseUint(fields[0][:16], 16, 64); err != nil {
			return fmt.Errorf("recovery checksum artifact %s is invalid", name)
		}
		for offset := 16; offset < 64; offset += 16 {
			if _, err := strconv.ParseUint(fields[0][offset:offset+16], 16, 64); err != nil {
				return fmt.Errorf("recovery checksum artifact %s is invalid", name)
			}
		}
		if len(fields) == 2 && strings.TrimPrefix(fields[1], "*") != strings.TrimSuffix(name, ".sha256") {
			return fmt.Errorf("recovery checksum artifact %s names an unexpected file", name)
		}
		return nil
	case name == "release.json" || name == "release-manifest.json" || name == "authority-release.json":
		if size <= 0 || size > 8<<20 {
			return fmt.Errorf("recovery release manifest %s has an invalid size", name)
		}
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()
		decoder := json.NewDecoder(io.LimitReader(file, (8<<20)+1))
		var manifest map[string]any
		if err := decoder.Decode(&manifest); err != nil || len(manifest) == 0 {
			return fmt.Errorf("recovery release manifest %s is invalid", name)
		}
		var extra any
		if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
			return fmt.Errorf("recovery release manifest %s has trailing data", name)
		}
		schema, schemaOK := manifest["schema_version"].(float64)
		sourceCommit, sourceOK := manifest["source_commit"].(string)
		if !schemaOK || schema != 1 || !sourceOK || !validCommit(sourceCommit) {
			return fmt.Errorf("recovery release manifest %s has an invalid release identity", name)
		}
		return nil
	default:
		return fmt.Errorf("unknown file in recovery download staging: %s", name)
	}
}

func (s *Service) removeSourceDataArtifacts(plan Plan) error {
	data := s.DestinationData
	files := []string{
		"auto-update-state.json",
		"auto-update-state.lock",
		"logs/auto-update.log",
		"runtimes/.upstream-sources.lock",
		"runtimes/agent/logs/install.log",
		"runtimes/agent/logs/runtime.log",
		"runtimes/camofox/.install.lock",
		"runtimes/camofox/logs/managed-camofox.log",
		"runtimes/firecrawl/.env",
		"runtimes/firecrawl/docker-compose.ubitech.yaml",
		"runtimes/firecrawl/logs/managed-firecrawl.log",
		"runtimes/searxng/docker-compose.ubitech.yaml",
		"runtimes/searxng/logs/managed-searxng.log",
	}
	for _, relative := range files {
		if err := removeOwnedRegular(data, filepath.Join(data, filepath.FromSlash(relative)), 64<<20, s.syncDirectory); err != nil {
			return err
		}
	}
	for _, relative := range []string{"runtimes/agent/app", "runtimes/agent/app.previous"} {
		if err := removeOwnedTree(data, filepath.Join(data, filepath.FromSlash(relative)), s.syncDirectory); err != nil {
			return err
		}
	}
	if err := removeKnownPrefixedEntries(filepath.Join(data, "runtimes", "agent"), []string{"app.staging-"}, s.syncDirectory); err != nil {
		return err
	}
	if err := removeKnownPrefixedEntries(filepath.Join(data, "runtimes", "camofox"), []string{"browser.staging-", "browser-download-"}, s.syncDirectory); err != nil {
		return err
	}
	if s.QuarantineRoot != "" && strings.TrimSpace(plan.OperationID) != "" {
		if _, err := os.Lstat(s.QuarantineRoot); err == nil {
			if err := removeOwnedTree(s.QuarantineRoot, filepath.Join(s.QuarantineRoot, plan.OperationID), s.syncDirectory); err != nil {
				return err
			}
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

type legacyDockerResource struct {
	Kind, Name, Project, Logical string
}

func (s *Service) removeLegacyComposeStorage(ctx context.Context, plan Plan) error {
	targets := legacyComposeTargets(plan.LegacyData)
	configured := make(map[string]bool, len(plan.ComposeProjects))
	for _, project := range plan.ComposeProjects {
		configured[project] = true
	}
	resources := []legacyDockerResource{
		{Kind: "network", Name: "firecrawl_backend", Project: "firecrawl", Logical: "backend"},
		{Kind: "volume", Name: "firecrawl_fdb-data", Project: "firecrawl", Logical: "fdb-data"},
		{Kind: "volume", Name: "firecrawl_fdb-cluster-file", Project: "firecrawl", Logical: "fdb-cluster-file"},
	}
	for _, target := range targets {
		if !configured[target.Project] {
			return fmt.Errorf("legacy Compose project %s is missing from the committed plan", target.Project)
		}
		if target.Project != "firecrawl" {
			resources = append(resources, legacyDockerResource{Kind: "network", Name: target.Project + "_default", Project: target.Project, Logical: "default"})
		}
	}
	for _, resource := range resources {
		if err := s.removeLegacyDockerResource(ctx, resource); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) removeLegacyDockerResource(ctx context.Context, resource legacyDockerResource) error {
	if !validComposeProject(resource.Project) || !validDockerResourceName(resource.Name) {
		return errors.New("legacy Docker resource identity is invalid")
	}
	binary := s.DockerBinary
	if binary == "" {
		binary = "docker"
	}
	result, err := s.runner().Run(ctx, binary, []string{resource.Kind, "ls", "-q", "--filter", "name=^" + regexp.QuoteMeta(resource.Name) + "$"}, nil)
	if err != nil {
		return fmt.Errorf("list legacy Docker %s %s: %w", resource.Kind, resource.Name, err)
	}
	items := strings.Fields(result.Stdout)
	if len(items) == 0 {
		return nil
	}
	if len(items) != 1 {
		return fmt.Errorf("legacy Docker %s %s did not resolve uniquely", resource.Kind, resource.Name)
	}
	if resource.Kind == "volume" {
		if items[0] != resource.Name {
			return fmt.Errorf("legacy Docker volume lookup returned unexpected name %q", items[0])
		}
	} else if !validContainerID(items[0]) {
		return errors.New("legacy Docker network lookup returned an invalid id")
	}
	labelsResult, err := s.runner().Run(ctx, binary, []string{resource.Kind, "inspect", "--format", "{{json .Labels}}", resource.Name}, nil)
	if err != nil {
		return fmt.Errorf("inspect legacy Docker %s %s labels: %w", resource.Kind, resource.Name, err)
	}
	var labels map[string]string
	if err := json.Unmarshal([]byte(strings.TrimSpace(labelsResult.Stdout)), &labels); err != nil {
		return fmt.Errorf("decode legacy Docker %s %s labels: %w", resource.Kind, resource.Name, err)
	}
	if labels["com.docker.compose.project"] != resource.Project || labels["com.docker.compose."+resource.Kind] != resource.Logical {
		return fmt.Errorf("legacy Docker %s %s has conflicting Compose ownership labels", resource.Kind, resource.Name)
	}
	if resource.Kind == "network" {
		attached, err := s.runner().Run(ctx, binary, []string{"network", "inspect", "--format", "{{len .Containers}}", resource.Name}, nil)
		if err != nil {
			return fmt.Errorf("inspect legacy Docker network %s attachments: %w", resource.Name, err)
		}
		count, err := strconv.Atoi(strings.TrimSpace(attached.Stdout))
		if err != nil || count != 0 {
			return fmt.Errorf("legacy Docker network %s still has attached containers", resource.Name)
		}
	}
	if _, err := s.runner().Run(ctx, binary, []string{resource.Kind, "rm", resource.Name}, nil); err != nil {
		return fmt.Errorf("remove legacy Docker %s %s: %w", resource.Kind, resource.Name, err)
	}
	return nil
}

func validDockerResourceName(value string) bool {
	if value == "" || len(value) > 255 {
		return false
	}
	for _, r := range value {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}

func removeOwnedRegular(root, path string, maxBytes int64, syncDir func(string) error) error {
	if err := verifyManagedPath(root, path); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("refusing non-regular source artifact %s", path)
	}
	if maxBytes > 0 && info.Size() > maxBytes {
		return fmt.Errorf("source artifact %s exceeds the cleanup size limit", path)
	}
	if err := requireOwned(path, info); err != nil {
		return err
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	return syncDir(filepath.Dir(path))
}

func removeOwnedTree(root, path string, syncDir func(string) error) error {
	if err := verifyManagedPath(root, path); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("refusing non-directory source artifact %s", path)
	}
	if err := requireOwned(path, info); err != nil {
		return err
	}
	if err := os.RemoveAll(path); err != nil {
		return err
	}
	return syncDir(filepath.Dir(path))
}

func removeKnownPrefixedFiles(root string, prefixes []string, maxBytes int64, syncDir func(string) error) error {
	entries, err := os.ReadDir(root)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if hasAnyPrefix(entry.Name(), prefixes) {
			if err := removeOwnedRegular(root, filepath.Join(root, entry.Name()), maxBytes, syncDir); err != nil {
				return err
			}
		}
	}
	return nil
}

func removeKnownPrefixedEntries(root string, prefixes []string, syncDir func(string) error) error {
	entries, err := os.ReadDir(root)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !hasAnyPrefix(entry.Name(), prefixes) {
			continue
		}
		path := filepath.Join(root, entry.Name())
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if info.IsDir() && info.Mode()&os.ModeSymlink == 0 {
			if err := removeOwnedTree(root, path, syncDir); err != nil {
				return err
			}
		} else {
			if err := removeOwnedRegular(root, path, 256<<20, syncDir); err != nil {
				return err
			}
		}
	}
	return nil
}

func removeExpectedUnitLink(path, expectedTarget string, syncDir func(string) error) error {
	root := filepath.Dir(filepath.Dir(path))
	if err := verifyManagedPath(root, path); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink == 0 {
		return fmt.Errorf("systemd wants entry %s is not a symlink", path)
	}
	if err := requireOwned(path, info); err != nil {
		return err
	}
	target, err := os.Readlink(path)
	if err != nil {
		return err
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(filepath.Dir(path), target)
	}
	if !samePath(target, expectedTarget) {
		return fmt.Errorf("systemd wants entry %s points outside the retired unit", path)
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	return syncDir(filepath.Dir(path))
}

func verifyManagedPath(root, path string) error {
	cleanRootPath, err := cleanRoot(root)
	if err != nil {
		return err
	}
	cleanPath, err := cleanRoot(path)
	if err != nil {
		return err
	}
	if samePath(cleanRootPath, cleanPath) || !isWithin(cleanRootPath, cleanPath) {
		return errors.New("source cleanup path is outside its exact managed root")
	}
	current := cleanRootPath
	rootInfo, err := os.Lstat(current)
	if err != nil {
		return err
	}
	if !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("source cleanup root is not a regular directory")
	}
	if err := requireOwned(current, rootInfo); err != nil {
		return err
	}
	relative, _ := filepath.Rel(cleanRootPath, filepath.Dir(cleanPath))
	if relative == "." {
		return nil
	}
	for _, component := range strings.Split(relative, string(filepath.Separator)) {
		current = filepath.Join(current, component)
		info, err := os.Lstat(current)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("source cleanup parent %s is not a regular directory", current)
		}
		if err := requireOwned(current, info); err != nil {
			return err
		}
	}
	return nil
}

func requireOwned(path string, info os.FileInfo) error {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Getuid()) {
		return fmt.Errorf("source artifact %s is not owned by the Manager user", path)
	}
	return nil
}

func hasAnyPrefix(value string, prefixes []string) bool {
	for _, prefix := range prefixes {
		if strings.HasPrefix(value, prefix) && len(value) > len(prefix) {
			return true
		}
	}
	return false
}
