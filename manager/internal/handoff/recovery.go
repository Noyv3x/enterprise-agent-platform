package handoff

import (
	"errors"
	"path/filepath"
)

const (
	RecoveryBundleDirectory = "recovery-bundle"
	RecoverySourceDirectory = "source"
	RecoveryBridgeDirectory = "bridge"
	RecoveryManifestName    = "manifest.json"
	RecoveryComposeName     = "compose.yaml"
)

// RecoveryBundlePaths are closed-world, transaction-derived paths. They are
// deliberately absent from the journal: the immutable journal binds the
// original path and content digest, while no caller can redirect the durable
// recovery copy to another tree.
type RecoveryBundlePaths struct {
	Root, SourceDirectory, BridgeDirectory string
	SourceManifest, SourceCompose          string
	BridgeManifest, BridgeCompose          string
}

func DeriveRecoveryBundlePaths(transactionDirectory, transactionID string) (RecoveryBundlePaths, error) {
	if !transactionIDPattern.MatchString(transactionID) || !canonicalAbsolutePath(transactionDirectory) ||
		filepath.Base(transactionDirectory) != transactionID {
		return RecoveryBundlePaths{}, errors.New("recovery bundle transaction path is invalid")
	}
	root := filepath.Join(transactionDirectory, RecoveryBundleDirectory)
	source := filepath.Join(root, RecoverySourceDirectory)
	bridge := filepath.Join(root, RecoveryBridgeDirectory)
	return RecoveryBundlePaths{
		Root: root, SourceDirectory: source, BridgeDirectory: bridge,
		SourceManifest: filepath.Join(source, RecoveryManifestName), SourceCompose: filepath.Join(source, RecoveryComposeName),
		BridgeManifest: filepath.Join(bridge, RecoveryManifestName), BridgeCompose: filepath.Join(bridge, RecoveryComposeName),
	}, nil
}
