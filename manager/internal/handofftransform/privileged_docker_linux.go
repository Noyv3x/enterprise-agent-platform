//go:build linux

package handofftransform

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

const privilegedContainerPIDs = 64

type DockerPrivilegedTreeFSOptions struct {
	Runner       driver.Runner
	DockerBinary string
	ControlRoot  string
	UID          int
	GID          int
}

// DockerPrivilegedTreeFS runs the release-pinned, single-purpose worker. It
// deliberately exposes no generic docker-run or arbitrary mount API.
type DockerPrivilegedTreeFS struct {
	runner      driver.Runner
	binary      string
	controlRoot string
	uid         int
	gid         int
}

var _ PrivilegedTreeFS = (*DockerPrivilegedTreeFS)(nil)

func NewDockerPrivilegedTreeFS(options DockerPrivilegedTreeFSOptions) (*DockerPrivilegedTreeFS, error) {
	uid, gid := options.UID, options.GID
	if uid < 0 {
		uid = os.Getuid()
	}
	if gid < 0 {
		gid = os.Getgid()
	}
	if uid == 0 && os.Getuid() != 0 {
		uid = os.Getuid()
	}
	if gid == 0 && os.Getgid() != 0 {
		gid = os.Getgid()
	}
	if err := validateAbsoluteRoot(options.ControlRoot, "privileged handoff control", uid); err != nil {
		return nil, err
	}
	binary := strings.TrimSpace(options.DockerBinary)
	if binary == "" {
		binary = "docker"
	}
	if strings.ContainsAny(binary, "\x00\r\n") || (strings.ContainsRune(binary, filepath.Separator) && (!filepath.IsAbs(binary) || filepath.Clean(binary) != binary)) {
		return nil, errors.New("privileged handoff Docker binary is invalid")
	}
	runner := options.Runner
	if runner == nil {
		runner = driver.CommandRunner{MaxOutputBytes: 64 << 10}
	}
	return &DockerPrivilegedTreeFS{runner: runner, binary: binary, controlRoot: options.ControlRoot, uid: uid, gid: gid}, nil
}

func (filesystem *DockerPrivilegedTreeFS) inventory(ctx context.Context, request PrivilegedTreeRequest) (PrivilegedTreeResult, error) {
	return filesystem.execute(ctx, request)
}

func (filesystem *DockerPrivilegedTreeFS) copy(ctx context.Context, request PrivilegedTreeRequest) (PrivilegedTreeResult, error) {
	return filesystem.execute(ctx, request)
}

func (filesystem *DockerPrivilegedTreeFS) remove(ctx context.Context, request PrivilegedTreeRequest) (PrivilegedTreeResult, error) {
	return filesystem.execute(ctx, request)
}

func (filesystem *DockerPrivilegedTreeFS) execute(ctx context.Context, request PrivilegedTreeRequest) (PrivilegedTreeResult, error) {
	wire, err := filesystem.workerRequest(request)
	if err != nil {
		return PrivilegedTreeResult{}, err
	}
	control := filepath.Join(filesystem.controlRoot, ".handoff-fs-"+wire.RequestSHA256[:24])
	container := privilegedContainerName(wire)
	labels := privilegedContainerLabels(wire)
	if err := filesystem.removeResidualContainer(ctx, container, labels, wire.ImageDigest); err != nil {
		return PrivilegedTreeResult{}, err
	}
	if err := filesystem.prepareControl(control, wire); err != nil {
		return PrivilegedTreeResult{}, err
	}
	cleanControl := true
	defer func() {
		if cleanControl {
			_ = filesystem.cleanupControl(control, wire)
		}
	}()

	args, err := filesystem.runArgs(wire, control, container, labels, request)
	if err != nil {
		return PrivilegedTreeResult{}, err
	}
	_, runErr := filesystem.runner.Run(ctx, filesystem.binary, args, []string{"DOCKER_CONFIG="})
	if runErr != nil {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		cleanupErr := filesystem.removeResidualContainer(cleanupCtx, container, labels, wire.ImageDigest)
		cancel()
		return PrivilegedTreeResult{}, errors.Join(fmt.Errorf("run privileged handoff filesystem worker: %w", runErr), cleanupErr)
	}
	if err := filesystem.removeResidualContainer(ctx, container, labels, wire.ImageDigest); err != nil {
		return PrivilegedTreeResult{}, fmt.Errorf("clean completed privileged worker container: %w", err)
	}
	var receipt privilegedWorkerReceipt
	if err := readStrictOwnerJSON(filepath.Join(control, "receipt.json"), filesystem.uid, &receipt); err != nil {
		return PrivilegedTreeResult{}, fmt.Errorf("read privileged worker receipt: %w", err)
	}
	if err := verifyPrivilegedReceipt(wire, receipt); err != nil {
		return PrivilegedTreeResult{}, err
	}
	if err := filesystem.cleanupControl(control, wire); err != nil {
		cleanControl = false
		return PrivilegedTreeResult{}, fmt.Errorf("clean privileged worker control files: %w", err)
	}
	cleanControl = false
	return PrivilegedTreeResult{
		Entries: cloneEntries(receipt.Entries), SourceEntries: cloneEntries(receipt.SourceEntries),
		TargetEntries: cloneEntries(receipt.TargetEntries), Removed: receipt.Removed,
	}, nil
}

func (filesystem *DockerPrivilegedTreeFS) workerRequest(request PrivilegedTreeRequest) (privilegedWorkerRequest, error) {
	if request.SchemaVersion != SchemaVersion || !transactionIDPattern.MatchString(request.TransactionID) ||
		!sha256Pattern.MatchString(request.RequestSHA256) || !resourceNamePattern.MatchString(request.ResourceName) ||
		!release.IsDigestReference(request.ImageDigest) {
		return privilegedWorkerRequest{}, errors.New("privileged tree request has an invalid immutable identity")
	}
	if request.Operation != PrivilegedInventory && request.Operation != PrivilegedCopy && request.Operation != PrivilegedRemove {
		return privilegedWorkerRequest{}, errors.New("privileged tree request has an unknown operation")
	}
	if request.SourcePath != "" {
		if !filepath.IsAbs(request.SourcePath) || filepath.Clean(request.SourcePath) != request.SourcePath || strings.ContainsAny(request.SourcePath, ",\x00\r\n") {
			return privilegedWorkerRequest{}, errors.New("privileged source path is invalid")
		}
	}
	if request.TargetRoot != "" {
		if !filepath.IsAbs(request.TargetRoot) || filepath.Clean(request.TargetRoot) != request.TargetRoot || strings.ContainsAny(request.TargetRoot, ",\x00\r\n") {
			return privilegedWorkerRequest{}, errors.New("privileged target root is invalid")
		}
	}
	if request.TargetRelative != "" {
		if err := validateRelative(request.TargetRelative); err != nil {
			return privilegedWorkerRequest{}, fmt.Errorf("privileged target relative path: %w", err)
		}
	}
	if err := validateOwners(request.SourceOwners, filesystem.uid, filesystem.gid, request.ResourceName, "source"); err != nil {
		return privilegedWorkerRequest{}, err
	}
	if err := validateOwners(request.TargetOwners, filesystem.uid, filesystem.gid, request.ResourceName, "target"); err != nil {
		return privilegedWorkerRequest{}, err
	}
	switch request.Operation {
	case PrivilegedInventory:
		if request.SourcePath == "" || request.TargetRoot != "" || request.TargetRelative != "" || len(request.ExpectedSource) != 0 || len(request.ExpectedTarget) != 0 || !zeroRemovalProof(request.RemovalProof) {
			return privilegedWorkerRequest{}, errors.New("privileged inventory request carries fields for another operation")
		}
	case PrivilegedCopy:
		if request.SourcePath == "" || request.TargetRoot == "" || request.TargetRelative == "" || len(request.ExpectedSource) == 0 || len(request.ExpectedTarget) != 0 || !zeroRemovalProof(request.RemovalProof) {
			return privilegedWorkerRequest{}, errors.New("privileged copy request is incomplete")
		}
	case PrivilegedRemove:
		if request.SourcePath != "" || request.TargetRoot == "" || request.TargetRelative == "" || len(request.ExpectedSource) != 0 || len(request.ExpectedTarget) == 0 ||
			validateRemovalProof(request.RemovalProof) != nil {
			return privilegedWorkerRequest{}, errors.New("privileged removal request lacks an exact proof")
		}
	}
	wire := privilegedWorkerRequest{
		SchemaVersion: privilegedProtocolSchema, Operation: request.Operation,
		TransactionID: request.TransactionID, DataRequestSHA256: request.RequestSHA256,
		ResourceName: request.ResourceName, Access: ContainerOwnedTree, ImageDigest: request.ImageDigest,
		ManagerUID: uint32(filesystem.uid), ManagerGID: uint32(filesystem.gid), TargetRelative: request.TargetRelative,
		SourceOwners:   ownerSet(request.SourceOwners, filesystem.uid, filesystem.gid),
		TargetOwners:   ownerSet(request.TargetOwners, filesystem.uid, filesystem.gid),
		ExpectedSource: cloneEntries(request.ExpectedSource), ExpectedTarget: cloneEntries(request.ExpectedTarget),
		RemovalProof: cloneRemovalProof(request.RemovalProof),
	}
	return sealPrivilegedRequest(wire)
}

func (filesystem *DockerPrivilegedTreeFS) runArgs(request privilegedWorkerRequest, control, container string, labels map[string]string, original PrivilegedTreeRequest) ([]string, error) {
	args := []string{
		"run", "--rm", "--name", container, "--pull=never", "--network=none", "--read-only", "--user=0:0",
		"--cap-drop=ALL", "--cap-add=CHOWN", "--cap-add=DAC_OVERRIDE", "--cap-add=FOWNER",
		"--security-opt=no-new-privileges:true", "--pids-limit=" + strconv.Itoa(privilegedContainerPIDs),
	}
	labelNames := make([]string, 0, len(labels))
	for name := range labels {
		labelNames = append(labelNames, name)
	}
	sort.Strings(labelNames)
	for _, name := range labelNames {
		args = append(args, "--label", name+"="+labels[name])
	}
	args = append(args, "--env", "HANDOFF_FS_IMAGE_DIGEST="+request.ImageDigest)
	args = append(args, "--mount", dockerBind(control, "/control", false))
	if original.SourcePath != "" {
		args = append(args, "--mount", dockerBind(original.SourcePath, "/source", true))
	}
	if original.TargetRoot != "" {
		args = append(args, "--mount", dockerBind(original.TargetRoot, "/target", false))
	}
	args = append(args, request.ImageDigest, "--request", "/control/request.json", "--receipt", "/control/receipt.json")
	return args, nil
}

func dockerBind(source, target string, readonly bool) string {
	value := "type=bind,src=" + source + ",dst=" + target
	if readonly {
		value += ",readonly"
	}
	return value
}

func privilegedContainerName(request privilegedWorkerRequest) string {
	transaction := strings.TrimPrefix(request.TransactionID, "handoff_")[:12]
	return identity.SourceProfile().MigrationContainerPrefix + "handoff-fs-" + transaction + "-" + request.ResourceName + "-" + request.RequestSHA256[:12]
}

func privilegedContainerLabels(request privilegedWorkerRequest) map[string]string {
	profile := identity.SourceProfile()
	return map[string]string{
		profile.Label("managed"):     "true",
		profile.Label("kind"):        "handoff-fs-helper",
		profile.Label("transaction"): request.TransactionID,
		profile.Label("request"):     request.RequestSHA256,
		profile.Label("resource"):    request.ResourceName,
		profile.Label("image"):       strings.TrimPrefix(request.ImageDigest[strings.LastIndex(request.ImageDigest, "@")+1:], "sha256:"),
	}
}

func (filesystem *DockerPrivilegedTreeFS) prepareControl(path string, request privilegedWorkerRequest) error {
	if _, err := os.Lstat(path); err == nil {
		if err := filesystem.cleanupControl(path, request); err != nil {
			return fmt.Errorf("clean residual privileged control directory: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := mkdirExact(path, 0o700, filesystem.uid); err != nil {
		return err
	}
	complete := false
	defer func() {
		if !complete {
			_ = filesystem.cleanupControl(path, request)
		}
	}()
	raw, err := json.Marshal(request)
	if err != nil {
		return err
	}
	if err := writeAtomicOwnerFile(filepath.Join(path, "request.json"), append(raw, '\n'), 0o600, filesystem.uid); err != nil {
		return err
	}
	if err := syncDirectory(path); err != nil {
		return err
	}
	complete = true
	return nil
}

func (filesystem *DockerPrivilegedTreeFS) cleanupControl(path string, request privilegedWorkerRequest) error {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("privileged control object is not a real directory")
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() != "request.json" && entry.Name() != "receipt.json" {
			return fmt.Errorf("unknown privileged control artifact %q", entry.Name())
		}
		filePath := filepath.Join(path, entry.Name())
		fileInfo, err := os.Lstat(filePath)
		if err != nil || !fileInfo.Mode().IsRegular() || fileInfo.Mode()&os.ModeSymlink != 0 {
			return errors.Join(err, fmt.Errorf("unsafe privileged control artifact %q", entry.Name()))
		}
		var value map[string]any
		if err := readStrictOwnerJSON(filePath, filesystem.uid, &value); err != nil {
			return err
		}
		if value["request_sha256"] != request.RequestSHA256 || value["transaction_id"] != request.TransactionID || value["resource_name"] != request.ResourceName {
			return errors.New("privileged control artifact belongs to another request")
		}
	}
	for _, name := range []string{"receipt.json", "request.json"} {
		if err := os.Remove(filepath.Join(path, name)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}

func (filesystem *DockerPrivilegedTreeFS) removeResidualContainer(ctx context.Context, name string, labels map[string]string, image string) error {
	result, err := filesystem.runner.Run(ctx, filesystem.binary, []string{"container", "ls", "--all", "--filter", "name=^/" + name + "$", "--format", "{{.Names}}"}, []string{"DOCKER_CONFIG="})
	if err != nil {
		return fmt.Errorf("enumerate privileged helper container: %w", err)
	}
	value := strings.TrimSpace(result.Stdout)
	if value == "" {
		return nil
	}
	if value != name || strings.Contains(value, "\n") {
		return errors.New("Docker returned an ambiguous privileged helper container")
	}
	inspect, err := filesystem.runner.Run(ctx, filesystem.binary, []string{"container", "inspect", "--format", "{{json .Config.Labels}}\n{{.Config.Image}}", name}, []string{"DOCKER_CONFIG="})
	if err != nil {
		return fmt.Errorf("inspect residual privileged helper container: %w", err)
	}
	parts := strings.Split(strings.TrimSpace(inspect.Stdout), "\n")
	if len(parts) != 2 || parts[1] != image {
		return errors.New("residual privileged helper container has an unexpected image")
	}
	var actual map[string]string
	if err := json.Unmarshal([]byte(parts[0]), &actual); err != nil {
		return fmt.Errorf("decode residual privileged helper labels: %w", err)
	}
	for key, expected := range labels {
		if actual[key] != expected {
			return errors.New("residual privileged helper container label identity differs")
		}
	}
	// Docker merges image metadata labels into Config.Labels. Permit those, but
	// fail closed if a residual container carries any additional label in our
	// management namespace; cleanup may never select a merely similar managed
	// container.
	prefix := identity.SourceProfile().LabelPrefix + "."
	for key := range actual {
		if strings.HasPrefix(key, prefix) {
			if _, expected := labels[key]; !expected {
				return errors.New("residual privileged helper container has an unexpected managed label")
			}
		}
	}
	if _, err := filesystem.runner.Run(ctx, filesystem.binary, []string{"container", "rm", "--force", name}, []string{"DOCKER_CONFIG="}); err != nil {
		return fmt.Errorf("remove exact residual privileged helper container: %w", err)
	}
	return nil
}
