package driver

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestSandboxCreateResourceFlags(t *testing.T) {
	for _, test := range []struct {
		name, memory, cpus, network, attachments string
		pids                                     int
	}{
		{"agent", "2g", "2", "core", "/data/attachments", 1024},
		{"chat", "768m", "1", "none", "", 256},
		{"configured", "512m", "0.5", "none", "", 128},
	} {
		t.Run(test.name, func(t *testing.T) {
			image := "sandbox@sha256:" + strings.Repeat("a", 64)
			runner := &recordingRunner{results: func(args []string) (Result, error) {
				if len(args) > 1 && args[0] == "image" && args[1] == "inspect" {
					return Result{Stdout: fmt.Sprintf("[%q]", image)}, nil
				}
				if args[0] == "inspect" {
					return Result{}, errors.New("not found")
				}
				return Result{}, nil
			}}
			docker := DockerCLI{Profile: testActiveProfile, Runner: runner, Binary: "docker"}
			spec := SandboxSpec{ContainerName: "agent-platform-sandbox-test", AgentHash: "abc", Image: image, Network: test.network, Workspace: "/data/workspace", Home: "/data/home", Environment: "/data/env", Attachments: test.attachments, Memory: test.memory, MemorySwap: test.memory, CPUs: test.cpus, PidsLimit: test.pids, UID: 1000, GID: 1000}
			if _, err := docker.EnsureSandboxWithResult(context.Background(), spec); err != nil {
				t.Fatal(err)
			}
			var create []string
			for _, call := range runner.calls {
				if call.args[0] == "create" {
					create = call.args
				}
			}
			flags := map[string]string{}
			mounts := []string{}
			for i := 0; i < len(create)-1; i++ {
				flags[create[i]] = create[i+1]
				if create[i] == "--mount" {
					mounts = append(mounts, create[i+1])
				}
				if create[i] == "--init" || strings.Contains(create[i], "no-new-privileges") {
					t.Fatalf("sudo/tini contract broken: %v", create)
				}
			}
			for key, value := range map[string]string{"--memory": test.memory, "--memory-swap": test.memory, "--cpus": test.cpus, "--pids-limit": fmt.Sprint(test.pids), "--network": test.network} {
				if flags[key] != value {
					t.Fatalf("%s = %q, want %q; %v", key, flags[key], value, create)
				}
			}
			wantMounts := 3
			if test.attachments != "" {
				wantMounts = 4
			}
			if len(mounts) != wantMounts {
				t.Fatalf("unexpected mounts: %v", mounts)
			}
		})
	}
}
