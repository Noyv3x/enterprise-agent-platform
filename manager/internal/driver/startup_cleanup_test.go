package driver

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStartupStopsUnregisteredSandboxesAndConfirms(t *testing.T) {
	profile, err := testActiveProfile.Profile()
	if err != nil {
		t.Fatal(err)
	}
	for _, failure := range []string{"", "ownership", "changed-ownership", "malformed-id", "stop", "still-running", "new-container", "list"} {
		t.Run(failure, func(t *testing.T) {
			id := strings.Repeat("a", 64)
			hash := strings.Repeat("b", 64)
			lists, stops := 0, 0
			runner := &recordingRunner{results: func(args []string) (Result, error) {
				switch args[0] {
				case "ps":
					if strings.Join(args, " ") != "ps --no-trunc --quiet --filter label="+profile.Label("sandbox")+"=true" {
						t.Fatalf("incorrect active profile scope: %v", args)
					}
					lists++
					if failure == "list" {
						return Result{}, errors.New("daemon unavailable")
					}
					if failure == "malformed-id" {
						return Result{Stdout: "not-a-container-id"}, nil
					}
					if lists == 1 || failure == "new-container" {
						return Result{Stdout: id}, nil
					}
					return Result{}, nil
				case "inspect":
					if args[len(args)-1] != id {
						t.Fatalf("cleanup did not fence exact container ID: %v", args)
					}
					if strings.Contains(args[2], ".State.Running") {
						return Result{Stdout: fmt.Sprintf("%t\t%t\t%s", failure == "still-running", failure != "changed-ownership", hash)}, nil
					}
					return Result{Stdout: fmt.Sprintf("%t\t%s", failure != "ownership", hash)}, nil
				case "stop":
					stops++
					if args[len(args)-1] != id {
						t.Fatalf("stopped wrong container: %v", args)
					}
					if failure == "stop" {
						return Result{}, errors.New("cannot stop")
					}
					return Result{}, nil
				default:
					t.Fatalf("unexpected cleanup mutation: %v", args)
					return Result{}, nil
				}
			}}
			docker := DockerCLI{Profile: testActiveProfile, Runner: runner}
			ctx, cancel := context.WithTimeout(context.Background(), 350*time.Millisecond)
			defer cancel()
			err := docker.StopRunningManagedSandboxes(ctx)
			if (err != nil) != (failure != "") {
				t.Fatalf("failure=%q error=%v", failure, err)
			}
			if failure == "" && (lists != 2 || stops != 1) {
				t.Fatalf("unregistered container not stopped and confirmed: lists=%d stops=%d", lists, stops)
			}
			if (failure == "ownership" || failure == "malformed-id") && stops != 0 {
				t.Fatal("foreign container stopped")
			}
		})
	}
}

func TestStartupForceStopsManySandboxesInOneBatch(t *testing.T) {
	const count = 80
	ids := make([]string, count)
	for i := range ids {
		ids[i] = fmt.Sprintf("%064x", i+1)
	}
	hash := strings.Repeat("b", 64)
	lists, stops, validated := 0, 0, 0
	runner := &recordingRunner{results: func(args []string) (Result, error) {
		switch args[0] {
		case "ps":
			lists++
			if lists == 1 {
				return Result{Stdout: strings.Join(ids, "\n")}, nil
			}
			return Result{}, nil
		case "inspect":
			if strings.Contains(args[2], ".State.Running") {
				return Result{Stdout: "false\ttrue\t" + hash}, nil
			}
			validated++
			return Result{Stdout: "true\t" + hash}, nil
		case "stop":
			stops++
			if validated != count || strings.Join(args, " ") != "stop --time 0 "+strings.Join(ids, " ") {
				t.Fatalf("cleanup must validate all identities then force-stop one batch: validated=%d args=%v", validated, args)
			}
			return Result{}, nil
		default:
			t.Fatalf("unexpected command: %v", args)
			return Result{}, nil
		}
	}}
	if err := (DockerCLI{Profile: testActiveProfile, Runner: runner}).StopRunningManagedSandboxes(context.Background()); err != nil {
		t.Fatal(err)
	}
	if stops != 1 || lists != 2 {
		t.Fatalf("missing batch stop or global confirmation: stops=%d lists=%d", stops, lists)
	}
}

func TestStartupRetriesTransientDockerFailures(t *testing.T) {
	for _, stage := range []string{"list", "inspect", "stop", "confirm-identity", "confirm-list"} {
		t.Run(stage, func(t *testing.T) {
			id, hash := strings.Repeat("a", 64), strings.Repeat("b", 64)
			stopped, failed := false, false
			runner := &recordingRunner{results: func(args []string) (Result, error) {
				current := args[0]
				if current == "ps" {
					current = "list"
					if stopped {
						current = "confirm-list"
					}
				} else if current == "inspect" && stopped {
					current = "confirm-identity"
				}
				if current == stage && !failed {
					failed = true
					return Result{}, errors.New("daemon temporarily unavailable")
				}
				switch current {
				case "list":
					return Result{Stdout: id}, nil
				case "inspect":
					return Result{Stdout: "true\t" + hash}, nil
				case "stop":
					stopped = true
				case "confirm-identity":
					return Result{Stdout: "false\ttrue\t" + hash}, nil
				}
				return Result{}, nil
			}}
			if err := (DockerCLI{Profile: testActiveProfile, Runner: runner}).StopRunningManagedSandboxes(context.Background()); err != nil {
				t.Fatal(err)
			}
			if !failed || !stopped {
				t.Fatal("transient failure did not recover and stop sandbox")
			}
		})
	}
}

func TestStartupRejectsMalformedOrForeignBatchBeforeStopping(t *testing.T) {
	for _, output := range []string{"false\t" + strings.Repeat("b", 64), "true\tbad-hash", "malformed"} {
		t.Run(output, func(t *testing.T) {
			inspects := 0
			runner := &recordingRunner{results: func(args []string) (Result, error) {
				switch args[0] {
				case "ps":
					return Result{Stdout: strings.Repeat("a", 64) + "\n" + strings.Repeat("c", 64)}, nil
				case "inspect":
					inspects++
					if inspects == 1 {
						return Result{Stdout: "true\t" + strings.Repeat("b", 64)}, nil
					}
					return Result{Stdout: output}, nil
				default:
					t.Fatalf("must not mutate any container in invalid batch: %v", args)
					return Result{}, nil
				}
			}}
			if err := (DockerCLI{Profile: testActiveProfile, Runner: runner}).StopRunningManagedSandboxes(context.Background()); err == nil {
				t.Fatal("accepted invalid ownership metadata")
			}
			if inspects != 2 {
				t.Fatalf("malformed data was retried: inspections=%d", inspects)
			}
		})
	}
}

func TestStartupCleanupDeadlineKillsDockerSubprocess(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "docker")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nexec sleep 30\n"), 0700); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	err := (DockerCLI{Profile: testActiveProfile, Binary: binary}).StopRunningManagedSandboxes(context.Background())
	elapsed := time.Since(started)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected cleanup deadline, got %v", err)
	}
	if elapsed > 15*time.Second {
		t.Fatalf("whole cleanup exceeded fifteen seconds: %s", elapsed)
	}
	t.Logf("blocked Docker subprocess terminated and cleanup returned after %s", elapsed)
}
