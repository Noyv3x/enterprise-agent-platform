//go:build linux

package handofftransform

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/contract"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

type stagingMarker struct {
	SchemaVersion int              `json:"schema_version"`
	TransactionID string           `json:"transaction_id"`
	RequestSHA256 string           `json:"request_sha256"`
	SourceRoot    string           `json:"source_root"`
	TargetRoot    string           `json:"target_root"`
	OwnerUID      int              `json:"owner_uid"`
	OwnerGID      int              `json:"owner_gid"`
	Resources     []markerResource `json:"resources"`
}

type markerResource struct {
	Name            string       `json:"name"`
	Kind            ResourceKind `json:"kind"`
	Access          AccessClass  `json:"access"`
	PrivilegedImage string       `json:"privileged_image,omitempty"`
	Target          string       `json:"target"`
	Type            NodeType     `json:"type"`
	TargetOwners    []Owner      `json:"target_owners"`
}

type requestIdentity struct {
	SchemaVersion int                       `json:"schema_version"`
	TransactionID string                    `json:"transaction_id"`
	SourceRoot    string                    `json:"source_root"`
	TargetRoot    string                    `json:"target_root"`
	ReserveBytes  uint64                    `json:"reserve_bytes"`
	SourceProfile string                    `json:"source_profile"`
	TargetProfile string                    `json:"target_profile"`
	Resources     []requestResourceIdentity `json:"resources"`
}

type requestResourceIdentity struct {
	Name                 string       `json:"name"`
	Kind                 ResourceKind `json:"kind"`
	Access               AccessClass  `json:"access"`
	PrivilegedImage      string       `json:"privileged_image,omitempty"`
	Source               string       `json:"source,omitempty"`
	Target               string       `json:"target"`
	Type                 NodeType     `json:"type"`
	Required             bool         `json:"required"`
	SourceOwners         []Owner      `json:"source_owners"`
	TargetOwners         []Owner      `json:"target_owners"`
	AdditionalBytes      uint64       `json:"additional_bytes"`
	SchemaIdentifier     string       `json:"schema_identifier,omitempty"`
	SchemaVersion        int          `json:"schema_version,omitempty"`
	TransformationSHA256 string       `json:"transformation_sha256,omitempty"`
}

type preparedRequest struct {
	request       Request
	resources     []Resource
	mapping       TechnicalMapping
	uid           int
	gid           int
	stage         string
	requestSHA256 string
	marker        stagingMarker
	// fenceBindingSHA256 is populated only by ProductionBoundary after its
	// independent target-writer fence succeeds. Ordinary staging cleanup never
	// carries this publication-removal authority.
	fenceBindingSHA256 string
}

// Stage constructs and validates a transaction-owned sibling staging tree.
// It never writes SourceRoot and never renames StagingRoot to TargetRoot.
func (e Engine) Stage(ctx context.Context, request Request) (result Result, resultErr error) {
	prepared, err := e.prepare(request)
	if err != nil {
		return Result{}, err
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}

	if _, err := os.Lstat(prepared.stage); err == nil {
		if err := e.cleanupPrepared(prepared); err != nil {
			return Result{}, fmt.Errorf("recover prior handoff staging: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return Result{}, fmt.Errorf("inspect handoff staging: %w", err)
	}

	required, sourceBefore, err := e.preflight(ctx, prepared)
	if err != nil {
		return Result{}, err
	}
	if err := mkdirExact(prepared.stage, 0o700, prepared.uid); err != nil {
		return Result{}, fmt.Errorf("create handoff staging: %w", err)
	}
	created := true
	defer func() {
		if resultErr == nil || errors.Is(resultErr, ErrInjectedCrash) || !created {
			return
		}
		if cleanupErr := e.cleanupPrepared(prepared); cleanupErr != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("clean failed handoff staging: %w", cleanupErr))
		}
	}()

	markerRaw, err := json.Marshal(prepared.marker)
	if err != nil {
		return Result{}, fmt.Errorf("encode handoff staging marker: %w", err)
	}
	if err := writeAtomicOwnerFile(filepath.Join(prepared.stage, markerName), append(markerRaw, '\n'), 0o600, prepared.uid); err != nil {
		return Result{}, fmt.Errorf("write handoff staging marker: %w", err)
	}
	if err := syncDirectory(prepared.stage); err != nil {
		return Result{}, fmt.Errorf("sync handoff staging marker: %w", err)
	}
	if err := e.inject(Point{Name: "marker_synced"}); err != nil {
		return Result{}, err
	}

	resourceManifests := make([]ResourceManifest, 0, len(prepared.resources))
	for _, resource := range prepared.resources {
		if err := ctx.Err(); err != nil {
			return Result{}, err
		}
		sourcePath := ""
		before := sourceBefore[resource.Name]
		if resource.Kind != Generated {
			sourcePath = filepath.Join(prepared.request.SourceRoot, filepath.FromSlash(resource.Source))
			if len(before) == 0 {
				resourceManifests = append(resourceManifests, ResourceManifest{
					Name: resource.Name, Kind: resource.Kind, Access: resource.Access, PrivilegedImage: resource.PrivilegedImage, Source: resource.Source,
					Target: resource.Target, SchemaIdentifier: resource.SchemaIdentifier,
					SchemaVersion: resource.SchemaVersion, Validation: "optional_source_absent",
				})
				continue
			}
		}
		targetPath := filepath.Join(prepared.stage, filepath.FromSlash(resource.Target))
		if err := ensureParents(prepared.stage, filepath.Dir(targetPath), prepared.uid); err != nil {
			return Result{}, fmt.Errorf("prepare target parents for %s: %w", resource.Name, err)
		}
		if _, err := os.Lstat(targetPath); !os.IsNotExist(err) {
			if err == nil {
				return Result{}, fmt.Errorf("target for resource %s already exists", resource.Name)
			}
			return Result{}, fmt.Errorf("inspect target for resource %s: %w", resource.Name, err)
		}

		transformSourcePath := sourcePath
		var structuredInputEntries []Entry
		if resource.Kind == Structured {
			transformSourcePath, structuredInputEntries, err = e.stageStructuredInput(ctx, prepared, resource, sourcePath, before)
			if err != nil {
				return Result{}, fmt.Errorf("stage read-only input for resource %s: %w", resource.Name, err)
			}
		}

		switch resource.Kind {
		case ByteExactFile, SecretFile:
			if err := e.copyFile(ctx, sourcePath, targetPath, resource, before); err != nil {
				return Result{}, fmt.Errorf("copy resource %s: %w", resource.Name, err)
			}
		case ByteExactTree:
			if resource.Access == ContainerOwnedTree {
				if _, err := e.copyPrivilegedTree(ctx, prepared, resource, sourcePath, before); err != nil {
					return Result{}, fmt.Errorf("copy privileged resource %s: %w", resource.Name, err)
				}
			} else if err := e.copyTree(ctx, sourcePath, targetPath, resource, before); err != nil {
				return Result{}, fmt.Errorf("copy resource %s: %w", resource.Name, err)
			}
		case Structured, Generated:
			if err := resource.Transformer.Transform(ctx, TransformInput{
				TransactionID: prepared.request.TransactionID,
				SourcePath:    transformSourcePath,
				TargetPath:    targetPath,
				Mapping:       prepared.mapping,
				SourceEntries: cloneEntries(before),
			}); err != nil {
				return Result{}, fmt.Errorf("transform resource %s with %s/%d: %w", resource.Name, resource.SchemaIdentifier, resource.SchemaVersion, err)
			}
		default:
			return Result{}, fmt.Errorf("resource %s has unsupported kind %q", resource.Name, resource.Kind)
		}

		after, err := e.inventory(ctx, prepared, resource, targetPath, false)
		if err != nil {
			return Result{}, fmt.Errorf("inventory target resource %s: %w", resource.Name, err)
		}
		if resource.Access == NativeAccess {
			if err := syncResource(targetPath, after); err != nil {
				return Result{}, fmt.Errorf("sync target resource %s: %w", resource.Name, err)
			}
		}

		validation := ValidationInput{
			TransactionID: prepared.request.TransactionID,
			Resource:      resource,
			SourcePath:    transformSourcePath,
			TargetPath:    targetPath,
			Mapping:       prepared.mapping,
			SourceEntries: cloneEntries(before),
			TargetEntries: cloneEntries(after),
		}
		if resource.Kind == ByteExactFile || resource.Kind == ByteExactTree || resource.Kind == SecretFile {
			if err := validateByteExact(validation); err != nil {
				return Result{}, fmt.Errorf("validate byte-exact resource %s: %w", resource.Name, err)
			}
		} else if err := resource.Validator.Validate(ctx, validation); err != nil {
			return Result{}, fmt.Errorf("validate structured resource %s with %s/%d: %w", resource.Name, resource.SchemaIdentifier, resource.SchemaVersion, err)
		}
		targetAfterValidation, err := e.inventory(ctx, prepared, resource, targetPath, false)
		if err != nil {
			return Result{}, fmt.Errorf("recheck validated target resource %s: %w", resource.Name, err)
		}
		if !entriesEqual(after, targetAfterValidation) {
			return Result{}, fmt.Errorf("validator mutated target resource %s", resource.Name)
		}
		if resource.Kind != Generated {
			sourceAfter, err := e.inventory(ctx, prepared, resource, sourcePath, true)
			if err != nil {
				return Result{}, fmt.Errorf("recheck source resource %s: %w", resource.Name, err)
			}
			if !entriesEqual(before, sourceAfter) {
				return Result{}, fmt.Errorf("source resource %s changed while staging", resource.Name)
			}
		}
		if resource.Kind == Structured {
			inputAfter, err := inventoryResource(ctx, resource.Name+"_input", transformSourcePath, resource.Type, []Owner{{UID: uint32(prepared.uid), GID: uint32(prepared.gid)}})
			if err != nil {
				return Result{}, fmt.Errorf("recheck read-only input for resource %s: %w", resource.Name, err)
			}
			if !entriesEqual(structuredInputEntries, inputAfter) {
				return Result{}, fmt.Errorf("transformer or validator mutated read-only input for resource %s", resource.Name)
			}
			if err := removeOwnedResource(transformSourcePath, inputAfter, prepared.uid); err != nil {
				return Result{}, fmt.Errorf("remove staged input for resource %s: %w", resource.Name, err)
			}
		}
		resourceManifests = append(resourceManifests, ResourceManifest{
			Name: resource.Name, Kind: resource.Kind, Access: resource.Access, PrivilegedImage: resource.PrivilegedImage, Source: resource.Source, Target: resource.Target,
			SchemaIdentifier: resource.SchemaIdentifier, SchemaVersion: resource.SchemaVersion,
			SourceEntries: cloneEntries(before), TargetEntries: cloneEntries(after), Validation: "verified",
		})
		if err := syncDirectory(filepath.Dir(targetPath)); err != nil {
			return Result{}, fmt.Errorf("sync target parent for %s: %w", resource.Name, err)
		}
		if err := e.inject(Point{Name: "resource_synced", Resource: resource.Name}); err != nil {
			return Result{}, err
		}
	}
	inputRoot := filepath.Join(prepared.stage, inputDirectoryName)
	if info, err := os.Lstat(inputRoot); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return Result{}, errors.New("structured input root has an unsafe type")
		}
		if err := os.Remove(inputRoot); err != nil {
			entries, listErr := os.ReadDir(inputRoot)
			names := make([]string, 0, len(entries))
			for _, entry := range entries {
				names = append(names, entry.Name())
			}
			return Result{}, fmt.Errorf("remove empty structured input root (remaining=%v): %w", names, errors.Join(err, listErr))
		}
	} else if !os.IsNotExist(err) {
		return Result{}, fmt.Errorf("inspect structured input root: %w", err)
	}
	if err := e.verifyFinalResources(ctx, prepared, sourceBefore, resourceManifests); err != nil {
		return Result{}, err
	}
	if _, err := os.Lstat(prepared.request.TargetRoot); err == nil {
		return Result{}, errors.New("final target root appeared while staging")
	} else if !os.IsNotExist(err) {
		return Result{}, fmt.Errorf("reinspect final target root: %w", err)
	}

	manifest := Manifest{
		SchemaVersion: ManifestSchema, TransactionID: prepared.request.TransactionID,
		SourceRoot: prepared.request.SourceRoot, TargetRoot: prepared.request.TargetRoot,
		SourceProfile: prepared.mapping.Source.ProfileID, TargetProfile: prepared.mapping.Target.ProfileID,
		RequiredBytes: required, Resources: resourceManifests, CreatedAt: e.now(),
	}
	if err := e.inject(Point{Name: "before_manifest"}); err != nil {
		return Result{}, err
	}
	manifestRaw, err := json.Marshal(manifest)
	if err != nil {
		return Result{}, fmt.Errorf("encode handoff transform manifest: %w", err)
	}
	manifestRaw = append(manifestRaw, '\n')
	manifestPath := filepath.Join(prepared.stage, manifestName)
	if err := writeAtomicOwnerFile(manifestPath, manifestRaw, 0o600, prepared.uid); err != nil {
		return Result{}, fmt.Errorf("write handoff transform manifest: %w", err)
	}
	if err := syncDirectory(prepared.stage); err != nil {
		return Result{}, fmt.Errorf("sync completed handoff staging: %w", err)
	}
	if err := syncDirectory(filepath.Dir(prepared.stage)); err != nil {
		return Result{}, fmt.Errorf("sync handoff staging parent: %w", err)
	}
	if err := e.inject(Point{Name: "manifest_synced"}); err != nil {
		return Result{}, err
	}
	digest := sha256.Sum256(manifestRaw)
	return Result{
		StagingRoot: prepared.stage, ManifestPath: manifestPath,
		ManifestSHA256: hex.EncodeToString(digest[:]), RequiredBytes: required, Manifest: manifest,
	}, nil
}

func (e Engine) stageStructuredInput(ctx context.Context, prepared preparedRequest, resource Resource, sourcePath string, before []Entry) (string, []Entry, error) {
	inputRoot := filepath.Join(prepared.stage, inputDirectoryName)
	if err := ensureParents(prepared.stage, inputRoot, prepared.uid); err != nil {
		return "", nil, err
	}
	inputPath := filepath.Join(inputRoot, resource.Name)
	switch resource.Type {
	case RegularFile:
		if err := e.copyFile(ctx, sourcePath, inputPath, resource, before); err != nil {
			return "", nil, err
		}
	case Directory:
		owner := Owner{UID: uint32(prepared.uid), GID: uint32(prepared.gid)}
		if err := e.copyTreeWithTargetOwner(ctx, sourcePath, inputPath, resource, before, &owner); err != nil {
			return "", nil, err
		}
	default:
		return "", nil, fmt.Errorf("invalid structured input type %q", resource.Type)
	}
	if err := makeResourceReadOnly(inputPath); err != nil {
		return "", nil, err
	}
	entries, err := inventoryResource(ctx, resource.Name+"_input", inputPath, resource.Type, []Owner{{UID: uint32(prepared.uid), GID: uint32(prepared.gid)}})
	if err != nil {
		return "", nil, err
	}
	if err := syncResource(inputPath, entries); err != nil {
		return "", nil, err
	}
	return inputPath, entries, nil
}

func (e Engine) verifyFinalResources(ctx context.Context, prepared preparedRequest, sourceBefore map[string][]Entry, manifests []ResourceManifest) error {
	manifestByName, err := indexExactManifestResources(prepared.resources, manifests)
	if err != nil {
		return err
	}
	for _, resource := range prepared.resources {
		if err := ctx.Err(); err != nil {
			return err
		}
		manifest, exists := manifestByName[resource.Name]
		if !exists {
			return fmt.Errorf("resource %s is missing final manifest evidence", resource.Name)
		}
		if resource.Kind != Generated {
			sourcePath := filepath.Join(prepared.request.SourceRoot, filepath.FromSlash(resource.Source))
			before := sourceBefore[resource.Name]
			if len(before) == 0 {
				if _, err := os.Lstat(sourcePath); !os.IsNotExist(err) {
					if err == nil {
						return fmt.Errorf("optional source resource %s appeared while staging", resource.Name)
					}
					return fmt.Errorf("reinspect optional source resource %s: %w", resource.Name, err)
				}
			} else {
				after, err := e.inventory(ctx, prepared, resource, sourcePath, true)
				if err != nil {
					return fmt.Errorf("final source verification for %s: %w", resource.Name, err)
				}
				if !entriesEqual(before, after) {
					return fmt.Errorf("source resource %s changed after its transformation completed", resource.Name)
				}
			}
		}
		targetPath := filepath.Join(prepared.stage, filepath.FromSlash(resource.Target))
		if manifest.Validation == "optional_source_absent" {
			if _, err := os.Lstat(targetPath); !os.IsNotExist(err) {
				if err == nil {
					return fmt.Errorf("target for absent optional resource %s appeared", resource.Name)
				}
				return fmt.Errorf("reinspect absent optional target %s: %w", resource.Name, err)
			}
			continue
		}
		targetEntries, err := e.inventory(ctx, prepared, resource, targetPath, false)
		if err != nil {
			return fmt.Errorf("final target verification for %s: %w", resource.Name, err)
		}
		if !entriesEqual(manifest.TargetEntries, targetEntries) {
			return fmt.Errorf("target resource %s changed after validation", resource.Name)
		}
		if resource.Access == NativeAccess {
			if err := syncResource(targetPath, targetEntries); err != nil {
				return fmt.Errorf("final sync for target resource %s: %w", resource.Name, err)
			}
		}
	}
	return syncDirectory(prepared.stage)
}

// Cleanup removes only a staging tree whose durable marker exactly matches the
// supplied immutable request and whose contents remain inside the declared
// target resource prefixes.
func (e Engine) Cleanup(request Request) error {
	prepared, err := e.prepare(request)
	if err != nil {
		return err
	}
	if _, err := os.Lstat(prepared.stage); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return fmt.Errorf("inspect handoff staging: %w", err)
	}
	return e.cleanupPrepared(prepared)
}

// VerifyStaged reopens the transaction-owned staging tree and proves that its
// marker, manifest and every declared resource still match the immutable
// request. It performs no writes and is the durable checkpoint used before an
// atomic publication rename.
func (e Engine) VerifyStaged(ctx context.Context, request Request) (Result, error) {
	prepared, err := e.prepare(request)
	if err != nil {
		return Result{}, err
	}
	return e.verifyPublishedRoot(ctx, prepared, prepared.stage)
}

// VerifyPublished recognizes the only accepted rename-crash checkpoint: the
// final target exists, the sibling staging path is absent, and the complete
// transaction marker/manifest/resources match this exact request.
func (e Engine) VerifyPublished(ctx context.Context, request Request) (Result, error) {
	prepared, err := e.prepareAllowTarget(request)
	if err != nil {
		return Result{}, err
	}
	if _, err := os.Lstat(prepared.stage); err == nil {
		return Result{}, errors.New("published target conflicts with an existing transaction staging tree")
	} else if !os.IsNotExist(err) {
		return Result{}, fmt.Errorf("inspect transaction staging beside published target: %w", err)
	}
	return e.verifyPublishedRoot(ctx, prepared, prepared.request.TargetRoot)
}

// Publish atomically renames a fully verified same-filesystem staging tree to
// the final target root. Replays after the rename return the independently
// verified published result instead of attempting a second rename.
func (e Engine) Publish(ctx context.Context, request Request) (Result, error) {
	if _, err := os.Lstat(request.TargetRoot); err == nil {
		return e.VerifyPublished(ctx, request)
	} else if !os.IsNotExist(err) {
		return Result{}, fmt.Errorf("inspect final target root before publish: %w", err)
	}
	result, err := e.VerifyStaged(ctx, request)
	if err != nil {
		return Result{}, err
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	if err := renameNoReplace(result.StagingRoot, request.TargetRoot); err != nil {
		return Result{}, fmt.Errorf("publish handoff target root without replacement: %w", err)
	}
	if err := syncDirectory(filepath.Dir(request.TargetRoot)); err != nil {
		return Result{}, fmt.Errorf("sync published handoff target parent: %w", err)
	}
	if err := e.inject(Point{Name: "target_published"}); err != nil {
		return Result{}, err
	}
	return e.VerifyPublished(ctx, request)
}

// removePublished removes only a final target tree that first proves the exact
// transaction request and closed-world resource inventory. It is deliberately
// package-private: ProductionBoundary is the sole caller and supplies the
// binding returned by its independent target-writer fence.
func (e Engine) removePublished(ctx context.Context, request Request, fenceBindingSHA256 string) error {
	if !sha256Pattern.MatchString(fenceBindingSHA256) {
		return errors.New("published target removal lacks a target-writer fence binding")
	}
	if _, err := os.Lstat(request.TargetRoot); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return fmt.Errorf("inspect published target before removal: %w", err)
	}
	prepared, err := e.prepareAllowTarget(request)
	if err != nil {
		return err
	}
	if _, err := os.Lstat(prepared.stage); err == nil {
		return errors.New("published target conflicts with an existing transaction staging tree")
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect transaction staging before published rollback: %w", err)
	}
	if err := e.verifyRemovablePublishedRoot(ctx, prepared); err != nil {
		return err
	}
	prepared.stage = prepared.request.TargetRoot
	prepared.fenceBindingSHA256 = fenceBindingSHA256
	return e.cleanupPrepared(prepared)
}

// verifyRemovablePublishedRoot proves that root is still the exact
// transaction publication and contains only resource paths declared by its
// immutable request. It deliberately does not compare target entry hashes or
// mtimes: before commit, the fenced target stack may have written SQLite
// WAL/SHM, lock files, control bind locks, and Runtime state inside those
// declared paths. Unknown paths, owners, types, links, devices, marker
// identities, or manifest bindings still fail closed before any deletion.
func (e Engine) verifyRemovablePublishedRoot(ctx context.Context, prepared preparedRequest) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	root := prepared.request.TargetRoot
	info, err := os.Lstat(root)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || stat.Uid != uint32(prepared.uid) || info.Mode().Perm()&0o022 != 0 {
		return errors.New("handoff publication root is not a safe transaction-owned directory")
	}
	var marker stagingMarker
	if err := readStrictOwnerJSON(filepath.Join(root, markerName), prepared.uid, &marker); err != nil {
		return fmt.Errorf("read handoff publication marker before rollback: %w", err)
	}
	if !reflect.DeepEqual(marker, prepared.marker) {
		return errors.New("handoff publication marker differs from the immutable rollback request")
	}
	if err := validatePublicationTree(root, prepared.marker.Resources, prepared.uid, prepared.gid); err != nil {
		return err
	}
	var manifest Manifest
	if err := readStrictOwnerJSON(filepath.Join(root, manifestName), prepared.uid, &manifest); err != nil {
		return fmt.Errorf("read handoff publication manifest before rollback: %w", err)
	}
	if manifest.SchemaVersion != ManifestSchema || manifest.TransactionID != prepared.request.TransactionID ||
		manifest.SourceRoot != prepared.request.SourceRoot || manifest.TargetRoot != prepared.request.TargetRoot ||
		manifest.SourceProfile != prepared.mapping.Source.ProfileID || manifest.TargetProfile != prepared.mapping.Target.ProfileID ||
		manifest.CreatedAt.IsZero() {
		return errors.New("handoff publication manifest identity is invalid for rollback")
	}
	manifestByName, err := indexExactManifestResources(prepared.resources, manifest.Resources)
	if err != nil {
		return err
	}
	for _, resource := range prepared.resources {
		evidence := manifestByName[resource.Name]
		if evidence.Kind != resource.Kind || evidence.Access != resource.Access || evidence.PrivilegedImage != resource.PrivilegedImage || evidence.Source != resource.Source || evidence.Target != resource.Target ||
			evidence.SchemaIdentifier != resource.SchemaIdentifier || evidence.SchemaVersion != resource.SchemaVersion {
			return fmt.Errorf("handoff rollback resource %q has an invalid manifest binding", evidence.Name)
		}
		switch evidence.Validation {
		case "verified":
			if resource.Access == ContainerOwnedTree {
				targetPath := filepath.Join(root, filepath.FromSlash(resource.Target))
				if _, err := e.inventory(ctx, prepared, resource, targetPath, false); err != nil {
					return fmt.Errorf("inventory privileged rollback resource %s: %w", resource.Name, err)
				}
			}
		case "optional_source_absent":
			if resource.Required || resource.Kind == Generated {
				return fmt.Errorf("handoff rollback resource %q has an invalid absent-source claim", evidence.Name)
			}
		default:
			return fmt.Errorf("handoff rollback resource %q lacks original validation evidence", evidence.Name)
		}
	}
	return nil
}

func (e Engine) verifyPublishedRoot(ctx context.Context, prepared preparedRequest, root string) (Result, error) {
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	info, err := os.Lstat(root)
	if err != nil {
		return Result{}, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || stat.Uid != uint32(prepared.uid) || info.Mode().Perm()&0o022 != 0 {
		return Result{}, errors.New("handoff publication root is not a safe transaction-owned directory")
	}
	var marker stagingMarker
	if err := readStrictOwnerJSON(filepath.Join(root, markerName), prepared.uid, &marker); err != nil {
		return Result{}, fmt.Errorf("read handoff publication marker: %w", err)
	}
	if !reflect.DeepEqual(marker, prepared.marker) {
		return Result{}, errors.New("handoff publication marker differs from the immutable request")
	}
	if err := validatePublicationTree(root, prepared.marker.Resources, prepared.uid, prepared.gid); err != nil {
		return Result{}, err
	}
	manifestPath := filepath.Join(root, manifestName)
	var manifest Manifest
	if err := readStrictOwnerJSON(manifestPath, prepared.uid, &manifest); err != nil {
		return Result{}, fmt.Errorf("read handoff publication manifest: %w", err)
	}
	if manifest.SchemaVersion != ManifestSchema || manifest.TransactionID != prepared.request.TransactionID ||
		manifest.SourceRoot != prepared.request.SourceRoot || manifest.TargetRoot != prepared.request.TargetRoot ||
		manifest.SourceProfile != prepared.mapping.Source.ProfileID || manifest.TargetProfile != prepared.mapping.Target.ProfileID {
		return Result{}, errors.New("handoff publication manifest identity is invalid")
	}
	manifestByName, err := indexExactManifestResources(prepared.resources, manifest.Resources)
	if err != nil {
		return Result{}, err
	}
	for _, resource := range prepared.resources {
		evidence := manifestByName[resource.Name]
		if evidence.Kind != resource.Kind || evidence.Access != resource.Access || evidence.PrivilegedImage != resource.PrivilegedImage || evidence.Source != resource.Source || evidence.Target != resource.Target ||
			evidence.SchemaIdentifier != resource.SchemaIdentifier || evidence.SchemaVersion != resource.SchemaVersion {
			return Result{}, fmt.Errorf("handoff publication resource %q has an invalid binding", evidence.Name)
		}
		targetPath := filepath.Join(root, filepath.FromSlash(resource.Target))
		if evidence.Validation == "optional_source_absent" {
			if _, err := os.Lstat(targetPath); !os.IsNotExist(err) {
				return Result{}, fmt.Errorf("optional absent target %s appeared", resource.Name)
			}
			continue
		}
		if evidence.Validation != "verified" {
			return Result{}, fmt.Errorf("handoff publication resource %s lacks verified evidence", resource.Name)
		}
		entries, err := e.inventory(ctx, prepared, resource, targetPath, false)
		if err != nil {
			return Result{}, fmt.Errorf("inventory published resource %s: %w", resource.Name, err)
		}
		if !entriesEqual(evidence.TargetEntries, entries) {
			return Result{}, fmt.Errorf("published resource %s differs from its manifest", resource.Name)
		}
	}
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		return Result{}, err
	}
	digest := sha256.Sum256(raw)
	return Result{StagingRoot: root, ManifestPath: manifestPath, ManifestSHA256: hex.EncodeToString(digest[:]), RequiredBytes: manifest.RequiredBytes, Manifest: manifest}, nil
}

func indexExactManifestResources(resources []Resource, manifests []ResourceManifest) (map[string]ResourceManifest, error) {
	if len(manifests) != len(resources) {
		return nil, errors.New("handoff publication manifest resource count is invalid")
	}
	expected := make(map[string]struct{}, len(resources))
	for _, resource := range resources {
		if _, exists := expected[resource.Name]; exists {
			return nil, fmt.Errorf("immutable handoff request contains duplicate resource %q", resource.Name)
		}
		expected[resource.Name] = struct{}{}
	}
	indexed := make(map[string]ResourceManifest, len(manifests))
	for _, manifest := range manifests {
		if _, exists := expected[manifest.Name]; !exists {
			return nil, fmt.Errorf("handoff publication manifest contains unknown resource %q", manifest.Name)
		}
		if _, exists := indexed[manifest.Name]; exists {
			return nil, fmt.Errorf("handoff publication manifest contains duplicate resource %q", manifest.Name)
		}
		indexed[manifest.Name] = manifest
	}
	for _, resource := range resources {
		if _, exists := indexed[resource.Name]; !exists {
			return nil, fmt.Errorf("handoff publication manifest omits request resource %q", resource.Name)
		}
	}
	return indexed, nil
}

func validatePublicationTree(root string, resources []markerResource, uid, gid int) error {
	privilegedRoots := make(map[string]struct{})
	for _, resource := range resources {
		if resource.Access == ContainerOwnedTree {
			privilegedRoots[resource.Target] = struct{}{}
		}
	}
	return filepath.WalkDir(root, func(path string, item os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == root {
			return nil
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || info.Mode()&os.ModeSymlink != 0 || (!info.IsDir() && !info.Mode().IsRegular()) {
			return errors.New("handoff publication contains an unsafe object")
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		owners, expectedType, allowed := cleanupPolicy(relative, resources, uid, gid, true)
		if !allowed || !ownerAllowed(uint32(stat.Uid), uint32(stat.Gid), owners) || (info.Mode().IsRegular() && stat.Nlink != 1) {
			return fmt.Errorf("unknown or unsafe object in handoff publication: %s", relative)
		}
		if expectedType != "" {
			if err := validateNodeType(info, expectedType); err != nil {
				return err
			}
		}
		if _, privileged := privilegedRoots[relative]; privileged {
			if !info.IsDir() {
				return fmt.Errorf("privileged publication resource %s is not a directory", relative)
			}
			return filepath.SkipDir
		}
		return nil
	})
}

func (e Engine) prepare(request Request) (preparedRequest, error) {
	return e.prepareRequest(request, false)
}

func (e Engine) prepareAllowTarget(request Request) (preparedRequest, error) {
	return e.prepareRequest(request, true)
}

func (e Engine) prepareRequest(request Request, allowTarget bool) (preparedRequest, error) {
	uid, gid := e.effectiveUID(), e.effectiveGID()
	if !transactionIDPattern.MatchString(request.TransactionID) {
		return preparedRequest{}, errors.New("invalid handoff transaction id")
	}
	if err := validateAbsoluteRoot(request.SourceRoot, "source", uid); err != nil {
		return preparedRequest{}, err
	}
	target := filepath.Clean(request.TargetRoot)
	if target != request.TargetRoot || !filepath.IsAbs(target) {
		return preparedRequest{}, errors.New("target root must be an absolute canonical path")
	}
	targetProfile := identity.TargetProfile()
	if filepath.Base(target) != targetProfile.DataDirectory {
		return preparedRequest{}, fmt.Errorf("target root basename must be %q", targetProfile.DataDirectory)
	}
	parent := filepath.Dir(target)
	if err := validateAbsoluteRoot(parent, "target parent", uid); err != nil {
		return preparedRequest{}, err
	}
	if pathsOverlap(request.SourceRoot, target) {
		return preparedRequest{}, errors.New("source and target roots overlap")
	}
	if _, err := os.Lstat(target); err == nil && !allowTarget {
		return preparedRequest{}, errors.New("final target root already exists")
	} else if err != nil && !os.IsNotExist(err) {
		return preparedRequest{}, fmt.Errorf("inspect final target root: %w", err)
	}
	if err := requireSameFilesystem(request.SourceRoot, parent); err != nil {
		return preparedRequest{}, err
	}

	resources := append([]Resource(nil), request.Resources...)
	sort.Slice(resources, func(i, j int) bool { return resources[i].Name < resources[j].Name })
	if len(resources) == 0 {
		return preparedRequest{}, errors.New("at least one handoff resource is required")
	}
	for index := range resources {
		if resources[index].Access == "" {
			resources[index].Access = NativeAccess
		}
	}
	if err := validateResources(resources, uid, gid); err != nil {
		return preparedRequest{}, err
	}
	for _, resource := range resources {
		if resource.Access == ContainerOwnedTree && e.PrivilegedTreeFS == nil {
			return preparedRequest{}, fmt.Errorf("resource %s requires an injected privileged tree filesystem", resource.Name)
		}
	}
	mapping := TechnicalMapping{Source: identity.SourceProfile(), Target: targetProfile}
	identityValue := requestIdentity{
		SchemaVersion: SchemaVersion, TransactionID: request.TransactionID,
		SourceRoot: request.SourceRoot, TargetRoot: request.TargetRoot, ReserveBytes: request.ReserveBytes,
		SourceProfile: mapping.Source.ProfileID, TargetProfile: mapping.Target.ProfileID,
	}
	markerResources := make([]markerResource, 0, len(resources))
	for index := range resources {
		resource := &resources[index]
		resource.SourceOwners = ownerSet(resource.SourceOwners, uid, gid)
		resource.TargetOwners = ownerSet(resource.TargetOwners, uid, gid)
		identityValue.Resources = append(identityValue.Resources, requestResourceIdentity{
			Name: resource.Name, Kind: resource.Kind, Access: resource.Access, PrivilegedImage: resource.PrivilegedImage, Source: resource.Source, Target: resource.Target,
			Type: resource.Type, Required: resource.Required, SourceOwners: resource.SourceOwners,
			TargetOwners: resource.TargetOwners, AdditionalBytes: resource.AdditionalBytes,
			SchemaIdentifier: resource.SchemaIdentifier, SchemaVersion: resource.SchemaVersion,
			TransformationSHA256: resource.TransformationSHA256,
		})
		markerResources = append(markerResources, markerResource{Name: resource.Name, Kind: resource.Kind, Access: resource.Access, PrivilegedImage: resource.PrivilegedImage, Target: resource.Target, Type: resource.Type, TargetOwners: resource.TargetOwners})
	}
	encoded, err := json.Marshal(identityValue)
	if err != nil {
		return preparedRequest{}, fmt.Errorf("encode handoff request identity: %w", err)
	}
	hash := sha256.Sum256(encoded)
	requestHash := hex.EncodeToString(hash[:])
	stage := filepath.Join(parent, "."+filepath.Base(target)+"."+request.TransactionID+".staging")
	return preparedRequest{
		request: request, resources: resources, mapping: mapping, uid: uid, gid: gid,
		stage: stage, requestSHA256: requestHash,
		marker: stagingMarker{
			SchemaVersion: SchemaVersion, TransactionID: request.TransactionID,
			RequestSHA256: requestHash, SourceRoot: request.SourceRoot, TargetRoot: request.TargetRoot,
			OwnerUID: uid, OwnerGID: gid, Resources: markerResources,
		},
	}, nil
}

func (e Engine) preflight(ctx context.Context, prepared preparedRequest) (uint64, map[string][]Entry, error) {
	sourceBefore := make(map[string][]Entry, len(prepared.resources))
	var required uint64
	for _, resource := range prepared.resources {
		if err := ctx.Err(); err != nil {
			return 0, nil, err
		}
		if resource.AdditionalBytes > ^uint64(0)-required {
			return 0, nil, fmt.Errorf("capacity requirement overflows at resource %s", resource.Name)
		}
		required += resource.AdditionalBytes
		if resource.Kind == Generated {
			continue
		}
		path := filepath.Join(prepared.request.SourceRoot, filepath.FromSlash(resource.Source))
		entries, err := e.inventory(ctx, prepared, resource, path, true)
		if os.IsNotExist(err) && !resource.Required {
			sourceBefore[resource.Name] = nil
			continue
		}
		if err != nil {
			return 0, nil, fmt.Errorf("inventory source resource %s: %w", resource.Name, err)
		}
		if resource.Kind == SecretFile {
			if len(entries) != 1 || entries[0].Type != RegularFile || entries[0].LinkCount != 1 || os.FileMode(entries[0].Mode).Perm()&0o077 != 0 {
				return 0, nil, fmt.Errorf("secret resource %s must be an owner-only, unlinked regular file", resource.Name)
			}
		}
		for _, entry := range entries {
			charge := uint64(0)
			if entry.Size > 0 {
				charge = uint64(entry.Size)
			}
			if entry.AllocatedSize > charge {
				charge = entry.AllocatedSize
			}
			if charge > ^uint64(0)-required {
				return 0, nil, fmt.Errorf("capacity requirement overflows at resource %s", resource.Name)
			}
			required += charge
			if resource.Kind == Structured {
				// Structured conversion holds a read-only transaction input and its
				// target output at the same time. Charge the source-sized input a
				// second time; AdditionalBytes covers reviewed expansion beyond it.
				if charge > ^uint64(0)-required {
					return 0, nil, fmt.Errorf("structured staging capacity overflows at resource %s", resource.Name)
				}
				required += charge
			}
		}
		sourceBefore[resource.Name] = entries
	}
	if prepared.request.ReserveBytes > ^uint64(0)-required {
		return 0, nil, errors.New("capacity reserve overflows")
	}
	requiredWithReserve := required + prepared.request.ReserveBytes
	var stat syscall.Statfs_t
	if err := syscall.Statfs(filepath.Dir(prepared.request.TargetRoot), &stat); err != nil {
		return 0, nil, fmt.Errorf("inspect target filesystem capacity: %w", err)
	}
	if stat.Bsize <= 0 || stat.Bavail > ^uint64(0)/uint64(stat.Bsize) {
		return 0, nil, errors.New("target filesystem capacity metadata is invalid")
	}
	available := stat.Bavail * uint64(stat.Bsize)
	if available < requiredWithReserve {
		return 0, nil, fmt.Errorf("insufficient target capacity: require %d bytes including reserve, have %d", requiredWithReserve, available)
	}
	return required, sourceBefore, nil
}

func validateResources(resources []Resource, uid, gid int) error {
	names := map[string]struct{}{}
	sources := map[string]string{}
	targets := map[string]string{}
	for _, resource := range resources {
		if !resourceNamePattern.MatchString(resource.Name) {
			return fmt.Errorf("invalid resource name %q", resource.Name)
		}
		if _, exists := names[resource.Name]; exists {
			return fmt.Errorf("duplicate resource name %q", resource.Name)
		}
		names[resource.Name] = struct{}{}
		if err := validateRelative(resource.Target); err != nil {
			return fmt.Errorf("resource %s target: %w", resource.Name, err)
		}
		if resource.Target == markerName || resource.Target == manifestName {
			return fmt.Errorf("resource %s targets reserved staging metadata", resource.Name)
		}
		if err := validateDataBoundary(resource); err != nil {
			return err
		}
		if err := validateManagerBoundary(resource); err != nil {
			return err
		}
		if prior, ok := overlappingPath(resource.Target, targets); ok {
			return fmt.Errorf("resource %s target overlaps resource %s", resource.Name, prior)
		}
		targets[resource.Target] = resource.Name
		switch resource.Access {
		case NativeAccess:
			if resource.PrivilegedImage != "" {
				return fmt.Errorf("native resource %s must not name a privileged image", resource.Name)
			}
		case ContainerOwnedTree:
			if resource.Kind != ByteExactTree || resource.Type != Directory {
				return fmt.Errorf("container-owned resource %s must be a byte-exact directory tree", resource.Name)
			}
			if !release.IsDigestReference(resource.PrivilegedImage) {
				return fmt.Errorf("container-owned resource %s must bind an immutable privileged image digest", resource.Name)
			}
		default:
			return fmt.Errorf("resource %s has unsupported access class %q", resource.Name, resource.Access)
		}
		switch resource.Kind {
		case ByteExactFile, SecretFile:
			if resource.Type != RegularFile {
				return fmt.Errorf("resource %s must declare file type", resource.Name)
			}
			if resource.Transformer != nil || resource.Validator != nil || resource.SourceExclude != nil || resource.SourceValidator != nil || resource.SourceInventoryValidator != nil || resource.SchemaIdentifier != "" || resource.SchemaVersion != 0 {
				return fmt.Errorf("byte-exact resource %s must not carry structured transformation fields", resource.Name)
			}
		case ByteExactTree:
			if resource.Type != Directory {
				return fmt.Errorf("resource %s must declare directory type", resource.Name)
			}
			if resource.Transformer != nil || resource.Validator != nil || resource.SourceExclude != nil || resource.SourceValidator != nil || resource.SourceInventoryValidator != nil || resource.SchemaIdentifier != "" || resource.SchemaVersion != 0 {
				return fmt.Errorf("byte-exact resource %s must not carry structured transformation fields", resource.Name)
			}
		case Structured:
			if resource.Type != RegularFile && resource.Type != Directory {
				return fmt.Errorf("structured resource %s has an invalid target type", resource.Name)
			}
			if resource.Transformer == nil || resource.Validator == nil || resource.SchemaIdentifier == "" || resource.SchemaVersion < 1 {
				return &UnsupportedSchemaError{Resource: resource.Name, Schema: fmt.Sprintf("%s/%d", resource.SchemaIdentifier, resource.SchemaVersion), Reason: "a reviewed transformer and independent validator are both required"}
			}
			if !sha256Pattern.MatchString(resource.TransformationSHA256) {
				return fmt.Errorf("structured resource %s must bind its semantic inputs with sha256", resource.Name)
			}
			if (resource.SourceExclude == nil) != (resource.SourceValidator == nil) {
				return fmt.Errorf("structured resource %s must pair source exclusion with an independent source validator", resource.Name)
			}
		case Generated:
			if resource.Source != "" {
				return fmt.Errorf("generated resource %s must not declare a source", resource.Name)
			}
			if resource.SourceExclude != nil || resource.SourceValidator != nil || resource.SourceInventoryValidator != nil {
				return fmt.Errorf("generated resource %s must not carry source-only validation", resource.Name)
			}
			if resource.Transformer == nil || resource.Validator == nil || resource.SchemaIdentifier == "" || resource.SchemaVersion < 1 {
				return &UnsupportedSchemaError{Resource: resource.Name, Schema: fmt.Sprintf("%s/%d", resource.SchemaIdentifier, resource.SchemaVersion), Reason: "a reviewed generator and independent validator are both required"}
			}
			if !sha256Pattern.MatchString(resource.TransformationSHA256) {
				return fmt.Errorf("generated resource %s must bind its generated bytes with sha256", resource.Name)
			}
		default:
			return fmt.Errorf("resource %s has unsupported kind %q", resource.Name, resource.Kind)
		}
		if resource.Kind != Generated {
			if err := validateRelative(resource.Source); err != nil {
				return fmt.Errorf("resource %s source: %w", resource.Name, err)
			}
			if prior, ok := overlappingPath(resource.Source, sources); ok {
				return fmt.Errorf("resource %s source overlaps resource %s", resource.Name, prior)
			}
			sources[resource.Source] = resource.Name
		}
		if err := validateOwners(resource.SourceOwners, uid, gid, resource.Name, "source"); err != nil {
			return err
		}
		if err := validateOwners(resource.TargetOwners, uid, gid, resource.Name, "target"); err != nil {
			return err
		}
	}
	return nil
}

func validateDataBoundary(resource Resource) error {
	validSource := resource.Kind == Generated || strings.HasPrefix(resource.Source, "data/") || strings.HasPrefix(resource.Source, "manager/")
	validTarget := strings.HasPrefix(resource.Target, "data/") || strings.HasPrefix(resource.Target, "manager/")
	if !validSource || !validTarget {
		return fmt.Errorf("resource %s must stay inside the explicit data/ or manager/ namespace", resource.Name)
	}
	// Whole-root transforms would turn the closed resource list back into
	// recursive discovery. Every rule must name a child of the namespace.
	if resource.Source == "data" || resource.Source == "manager" || resource.Target == "data" || resource.Target == "manager" {
		return fmt.Errorf("resource %s may not claim an entire data or Manager namespace", resource.Name)
	}
	for _, path := range []string{resource.Source, resource.Target} {
		if path == "" {
			continue
		}
		parts := strings.Split(path, "/")
		for _, part := range parts {
			if part == "logs" || part == "upload-staging" {
				if resource.Kind == Generated && resource.Source == "" && generatedDisposableTarget(resource.Target) {
					continue
				}
				return fmt.Errorf("resource %s attempts to migrate disposable %s state", resource.Name, part)
			}
		}
	}
	if resource.Kind == ByteExactFile || resource.Kind == ByteExactTree {
		if !byteExactDataPathAllowed(resource.Source) || !byteExactDataPathAllowed(resource.Target) {
			return fmt.Errorf("resource %s requires a versioned structured transformer; byte-exact migration is not approved for this path", resource.Name)
		}
	}
	return nil
}

func generatedDisposableTarget(path string) bool {
	switch path {
	case "manager/logs", "data/logs", "data/upload-staging",
		"data/runtimes/camofox/logs", "data/runtimes/cognee/logs",
		"data/runtimes/searxng/logs", "data/runtimes/firecrawl/logs":
		return true
	default:
		return false
	}
}

func byteExactDataPathAllowed(path string) bool {
	for _, prefix := range []string{
		"data/attachments",
		"data/agent-envs",
		"data/agent-skills",
		"data/runtimes/camofox/profiles",
		"data/runtimes/camofox/cookies",
		"data/runtimes/camofox/traces",
		"data/runtimes/cognee/data",
		"data/runtimes/cognee/system",
		"data/runtimes/cognee/cache",
		"data/runtimes/searxng/config",
		"data/runtimes/searxng/cache",
		"data/runtimes/firecrawl/redis",
		"data/runtimes/firecrawl/rabbitmq",
		"data/runtimes/firecrawl/postgres",
	} {
		if path == prefix || strings.HasPrefix(path, prefix+"/") {
			return true
		}
	}
	return false
}

func validateManagerBoundary(resource Resource) error {
	const manager = "manager/"
	if strings.HasPrefix(resource.Source, manager) {
		allowedSecret := strings.HasPrefix(resource.Source, "manager/secrets/") && isSecretName(strings.TrimPrefix(resource.Source, "manager/secrets/")) && resource.Kind == SecretFile
		allowedRegistry := resource.Source == "manager/sandboxes.json" && resource.Kind == Structured
		if !allowedSecret && !allowedRegistry {
			return fmt.Errorf("resource %s attempts to copy source Manager state outside the secret/registry whitelist", resource.Name)
		}
	}
	if !strings.HasPrefix(resource.Target, manager) {
		return nil
	}
	if resource.Target == "manager/operations" || resource.Target == "manager/logs" {
		if resource.Kind != Generated || resource.Type != Directory {
			return fmt.Errorf("resource %s must generate a fresh empty target Manager directory", resource.Name)
		}
		return nil
	}
	if resource.Target == "manager/manager-binaries/serve.lock" || resource.Target == "manager/manager-binaries/recovery.lock" {
		if resource.Kind != Generated || resource.Type != RegularFile {
			return fmt.Errorf("resource %s must generate a fresh empty target Manager lock", resource.Name)
		}
		return nil
	}
	if strings.HasPrefix(resource.Target, "manager/manager-binaries/versions/") {
		parts := strings.Split(resource.Target, "/")
		if len(parts) != 5 || parts[3] == "" || productionSafeID(parts[3]) != parts[3] ||
			(parts[4] != identity.TargetProfile().ManagerBinary && parts[4] != "metadata.json") ||
			resource.Kind != Generated || resource.Type != RegularFile {
			return fmt.Errorf("resource %s has an invalid generated target Manager version artifact", resource.Name)
		}
		return nil
	}
	forbidden := []string{
		"manager/operations", "manager/manager-binaries",
		"manager/recoveries", "manager/recovery", "manager/serve.lock", "manager/recovery.lock",
		"manager/logs", "manager/control/manager.sock", "manager/downloads",
	}
	for _, path := range forbidden {
		if resource.Target == path || strings.HasPrefix(resource.Target, path+"/") || strings.HasPrefix(path, resource.Target+"/") {
			return fmt.Errorf("resource %s targets forbidden inherited Manager state %s", resource.Name, path)
		}
	}
	if strings.HasPrefix(resource.Target, "manager/secrets/") {
		name := strings.TrimPrefix(resource.Target, "manager/secrets/")
		if resource.Kind != SecretFile || !isSecretName(name) {
			return fmt.Errorf("resource %s is not an individually allow-listed Manager secret", resource.Name)
		}
		return nil
	}
	if resource.Target == "manager/sandboxes.json" {
		if resource.Kind != Structured {
			return fmt.Errorf("resource %s must structurally regenerate the Sandbox registry", resource.Name)
		}
		return nil
	}
	// Every other target Manager artifact must be newly generated or
	// structurally assembled from signed inputs. Byte-for-byte source Manager
	// state is never a valid target baseline.
	if resource.Kind != Generated {
		return fmt.Errorf("resource %s must generate fresh target Manager state", resource.Name)
	}
	return nil
}

func isSecretName(name string) bool {
	for _, allowed := range contract.P1ManagerSecretNames {
		if name == allowed {
			return true
		}
	}
	return false
}

func validateOwners(owners []Owner, uid, gid int, resource, side string) error {
	seen := map[Owner]struct{}{}
	for _, owner := range ownerSet(owners, uid, gid) {
		if _, exists := seen[owner]; exists {
			return fmt.Errorf("resource %s has duplicate %s owner %d:%d", resource, side, owner.UID, owner.GID)
		}
		seen[owner] = struct{}{}
	}
	return nil
}

func ownerSet(owners []Owner, uid, gid int) []Owner {
	if len(owners) == 0 {
		return []Owner{{UID: uint32(uid), GID: uint32(gid)}}
	}
	out := append([]Owner(nil), owners...)
	sort.Slice(out, func(i, j int) bool {
		if out[i].UID == out[j].UID {
			return out[i].GID < out[j].GID
		}
		return out[i].UID < out[j].UID
	})
	return out
}

func validateRelative(value string) error {
	if value == "" || filepath.IsAbs(value) || filepath.Clean(value) != value || filepath.ToSlash(value) != value || value == "." || value == ".." || strings.HasPrefix(value, "../") {
		return errors.New("path must be a non-empty canonical slash-separated relative path")
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return errors.New("path contains an invalid segment")
		}
	}
	return nil
}

func overlappingPath(path string, known map[string]string) (string, bool) {
	for prior, name := range known {
		if path == prior || strings.HasPrefix(path, prior+"/") || strings.HasPrefix(prior, path+"/") {
			return name, true
		}
	}
	return "", false
}

func pathsOverlap(left, right string) bool {
	left, right = filepath.Clean(left), filepath.Clean(right)
	return left == right || strings.HasPrefix(left, right+string(filepath.Separator)) || strings.HasPrefix(right, left+string(filepath.Separator))
}

func requireSameFilesystem(source, targetParent string) error {
	sourceInfo, err := os.Lstat(source)
	if err != nil {
		return fmt.Errorf("inspect source filesystem: %w", err)
	}
	targetInfo, err := os.Lstat(targetParent)
	if err != nil {
		return fmt.Errorf("inspect target filesystem: %w", err)
	}
	sourceStat, sourceOK := sourceInfo.Sys().(*syscall.Stat_t)
	targetStat, targetOK := targetInfo.Sys().(*syscall.Stat_t)
	if !sourceOK || !targetOK || sourceStat.Dev != targetStat.Dev {
		return errors.New("source and target sibling staging must be on the same filesystem")
	}
	return nil
}

func (e Engine) now() time.Time {
	if e.Now != nil {
		return e.Now().UTC()
	}
	return time.Now().UTC()
}

func (e Engine) inject(point Point) error {
	if e.Fault == nil {
		return nil
	}
	return e.Fault(point)
}
