package main

import (
	"fmt"
	"io"
	"os"
	"syscall"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/release"
)

// inspectReleaseCommand deliberately bypasses configuration and application setup.
func inspectReleaseCommand(arguments []string, output io.Writer) error {
	parsed, err := parseStartupArguments("inspect-release", arguments)
	if err != nil {
		return err
	}
	if parsed.Architecture != "amd64" && parsed.Architecture != "arm64" {
		return fmt.Errorf("unsupported architecture %q", parsed.Architecture)
	}
	file, err := os.OpenFile(parsed.ManifestPath, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("release manifest must be a regular file")
	}
	manifest, err := release.ReadManifest(file, "main", "linux", parsed.Architecture)
	if err != nil {
		return err
	}
	artifact := manifest.Manager.Artifacts[parsed.Architecture]
	_, err = fmt.Fprintf(output, "%s\n%s\n", artifact.URL, artifact.SHA256)
	return err
}
