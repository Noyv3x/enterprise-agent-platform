//go:build linux

package handofftransform

import (
	"context"
	"errors"
	"fmt"
	pathpkg "path"
	"path/filepath"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
)

func (e Engine) inventory(ctx context.Context, prepared preparedRequest, resource Resource, path string, source bool) ([]Entry, error) {
	owners := resource.TargetOwners
	if source {
		owners = resource.SourceOwners
	}
	if resource.Access == NativeAccess {
		if source && resource.SourceValidator != nil {
			if err := resource.SourceValidator.ValidateSource(ctx, path); err != nil {
				return nil, err
			}
		}
		var exclude func(string) bool
		if source {
			exclude = resource.SourceExclude
		}
		entries, err := inventoryResourceFiltered(ctx, resource.Name, path, resource.Type, owners, exclude)
		if err != nil {
			return nil, err
		}
		if source && resource.SourceInventoryValidator != nil {
			if err := resource.SourceInventoryValidator.ValidateSourceInventory(entries); err != nil {
				return nil, err
			}
		}
		return entries, nil
	}
	if resource.Access != ContainerOwnedTree || e.PrivilegedTreeFS == nil {
		return nil, errors.New("container-owned tree has no privileged filesystem capability")
	}
	result, err := e.PrivilegedTreeFS.inventory(ctx, PrivilegedTreeRequest{
		SchemaVersion: SchemaVersion, Operation: PrivilegedInventory,
		TransactionID: prepared.request.TransactionID, RequestSHA256: prepared.requestSHA256,
		ResourceName: resource.Name, ImageDigest: resource.PrivilegedImage,
		SourcePath: path, SourceOwners: cloneOwners(owners), TargetOwners: cloneOwners(owners),
	})
	if err != nil {
		return nil, err
	}
	if result.Removed || len(result.SourceEntries) != 0 || len(result.TargetEntries) != 0 {
		return nil, errors.New("privileged inventory returned fields for another operation")
	}
	entries := cloneEntries(result.Entries)
	if err := validatePrivilegedEntries(resource, entries, owners); err != nil {
		return nil, err
	}
	if source && resource.SourceInventoryValidator != nil {
		if err := resource.SourceInventoryValidator.ValidateSourceInventory(entries); err != nil {
			return nil, err
		}
	}
	return entries, nil
}

func (e Engine) copyPrivilegedTree(ctx context.Context, prepared preparedRequest, resource Resource, sourcePath string, expected []Entry) ([]Entry, error) {
	if e.PrivilegedTreeFS == nil {
		return nil, errors.New("container-owned tree has no privileged filesystem capability")
	}
	result, err := e.PrivilegedTreeFS.copy(ctx, PrivilegedTreeRequest{
		SchemaVersion: SchemaVersion, Operation: PrivilegedCopy,
		TransactionID: prepared.request.TransactionID, RequestSHA256: prepared.requestSHA256,
		ResourceName: resource.Name, ImageDigest: resource.PrivilegedImage,
		SourcePath: sourcePath, TargetRoot: prepared.stage, TargetRelative: resource.Target,
		SourceOwners: cloneOwners(resource.SourceOwners), TargetOwners: cloneOwners(resource.TargetOwners),
		ExpectedSource: cloneEntries(expected),
	})
	if err != nil {
		return nil, err
	}
	if result.Removed || len(result.Entries) != 0 {
		return nil, errors.New("privileged copy returned fields for another operation")
	}
	if !entriesEqual(expected, result.SourceEntries) {
		return nil, errors.New("privileged copy source receipt differs from preflight inventory")
	}
	if err := validatePrivilegedEntries(resource, result.TargetEntries, resource.TargetOwners); err != nil {
		return nil, fmt.Errorf("validate privileged copy receipt: %w", err)
	}
	if err := validateByteExact(ValidationInput{Resource: resource, SourceEntries: expected, TargetEntries: result.TargetEntries}); err != nil {
		return nil, fmt.Errorf("privileged copy receipt is not byte-exact: %w", err)
	}
	return cloneEntries(result.TargetEntries), nil
}

func (e Engine) removePrivilegedTree(ctx context.Context, prepared preparedRequest, root string, resource Resource, expected []Entry, proof PrivilegedRemovalProof) error {
	if e.PrivilegedTreeFS == nil {
		return errors.New("container-owned tree has no privileged filesystem capability")
	}
	result, err := e.PrivilegedTreeFS.remove(ctx, PrivilegedTreeRequest{
		SchemaVersion: SchemaVersion, Operation: PrivilegedRemove,
		TransactionID: prepared.request.TransactionID, RequestSHA256: prepared.requestSHA256,
		ResourceName: resource.Name, ImageDigest: resource.PrivilegedImage,
		TargetRoot: root, TargetRelative: resource.Target,
		SourceOwners: cloneOwners(resource.SourceOwners), TargetOwners: cloneOwners(resource.TargetOwners),
		ExpectedTarget: cloneEntries(expected), RemovalProof: proof,
	})
	if err != nil {
		return err
	}
	if !result.Removed || len(result.Entries) != 0 || len(result.SourceEntries) != 0 || len(result.TargetEntries) != 0 {
		return errors.New("privileged removal did not return an exact absence receipt")
	}
	if _, err := filepath.Rel(root, filepath.Join(root, filepath.FromSlash(resource.Target))); err != nil {
		return errors.New("privileged removal target binding is invalid")
	}
	return nil
}

func validatePrivilegedEntries(resource Resource, entries []Entry, owners []Owner) error {
	if len(entries) == 0 || entries[0].Path != "." || entries[0].Type != Directory {
		return errors.New("privileged tree inventory has no directory root")
	}
	prior := ""
	directoryCounts := map[string]int{}
	for index, entry := range entries {
		if entry.Resource != resource.Name || entry.Path == "" || (index > 0 && entry.Path <= prior) {
			return errors.New("privileged tree inventory is not canonically ordered and resource-bound")
		}
		if entry.Path != "." {
			if err := validateRelative(entry.Path); err != nil {
				return fmt.Errorf("invalid privileged inventory path: %w", err)
			}
			parent := pathpkg.Dir(entry.Path)
			directoryCounts[parent]++
			if directoryCounts[parent] > contract.AgentRuntimeMaximumDirectoryEntries {
				return fmt.Errorf("privileged inventory directory %s exceeds the canonical entry limit", parent)
			}
		}
		if !ownerAllowed(entry.UID, entry.GID, owners) || entry.LinkCount < 1 {
			return fmt.Errorf("privileged inventory path %s has an undeclared owner or link count", entry.Path)
		}
		if entry.Type == RegularFile {
			if entry.LinkCount != 1 || !sha256Pattern.MatchString(entry.SHA256) || entry.Size < 0 {
				return fmt.Errorf("privileged inventory file %s is unsafe", entry.Path)
			}
		} else if entry.Type != Directory || entry.SHA256 != "" {
			return fmt.Errorf("privileged inventory path %s has an unsupported type", entry.Path)
		}
		prior = entry.Path
	}
	return nil
}

func cloneOwners(values []Owner) []Owner { return append([]Owner(nil), values...) }
