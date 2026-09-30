package driver

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestManagedPullBoundAndSingleCapacityReservation(t *testing.T) {
	manifest := pullTestManifest()
	names := []string{"platform", "agent-runtime", "agent-sandbox", "camofox", "searxng"}
	started := make(chan string, len(names))
	releasePull := make(chan struct{})
	var active, maximum, reservations atomic.Int32
	runner := &pullTestRunner{present: map[string]bool{}, pull: func(ctx context.Context, image string, _ func()) (Result, error) {
		n := active.Add(1)
		defer active.Add(-1)
		for old := maximum.Load(); n > old && !maximum.CompareAndSwap(old, n); old = maximum.Load() {
		}
		started <- image
		select {
		case <-releasePull:
			return Result{}, nil
		case <-ctx.Done():
			return Result{}, ctx.Err()
		}
	}}
	docker := pullTestDocker(runner, time.Second, 2*time.Second)
	stat := docker.FilesystemStat
	docker.FilesystemStat = func(ctx context.Context, path string) (CapacityFilesystemStat, error) {
		reservations.Add(1)
		return stat(ctx, path)
	}
	done := make(chan error, 1)
	go func() { done <- docker.prepareManagedImages(context.Background(), manifest, names) }()
	for range 3 {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("three parallel pulls did not start")
		}
	}
	close(releasePull)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if maximum.Load() != 3 || reservations.Load() != 1 {
		t.Fatalf("maximum pulls=%d capacity reservations=%d", maximum.Load(), reservations.Load())
	}
	for _, name := range names {
		if !runner.present[manifest.Images[name]] {
			t.Fatalf("missing verified image %s", name)
		}
	}
}

func TestManagedPullFailureCancelsAndJoinsBeforeUnlock(t *testing.T) {
	manifest := pullTestManifest()
	started := make(chan struct{}, 3)
	fail := make(chan struct{})
	cancelled := make(chan struct{}, 2)
	exit := make(chan struct{})
	var joined atomic.Int32
	runner := &pullTestRunner{present: map[string]bool{}, pull: func(ctx context.Context, image string, _ func()) (Result, error) {
		started <- struct{}{}
		if image == manifest.Images["platform"] {
			<-fail
			return Result{}, errors.New("registry refused platform")
		}
		<-ctx.Done()
		cancelled <- struct{}{}
		<-exit
		joined.Add(1)
		return Result{}, ctx.Err()
	}}
	docker := pullTestDocker(runner, time.Second, 2*time.Second)
	docker.ManagedImageMu = &sync.Mutex{}
	done := make(chan error, 1)
	go func() { done <- docker.Pull(context.Background(), manifest) }()
	for range 3 {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("pull did not start")
		}
	}
	close(fail)
	for range 2 {
		select {
		case <-cancelled:
		case <-time.After(time.Second):
			t.Fatal("peer pull was not cancelled")
		}
	}
	select {
	case err := <-done:
		t.Fatalf("returned before peer pulls joined: %v", err)
	default:
	}
	if docker.ManagedImageMu.TryLock() {
		docker.ManagedImageMu.Unlock()
		t.Fatal("cleanup mutex released while pulls active")
	}
	close(exit)
	if err := <-done; err == nil || !strings.Contains(err.Error(), "registry refused platform") {
		t.Fatalf("lost original pull failure: %v", err)
	}
	if joined.Load() != 2 || !docker.ManagedImageMu.TryLock() {
		t.Fatal("pulls not joined or cleanup mutex not released")
	}
	docker.ManagedImageMu.Unlock()
}

func TestParallelPullVerifiesEveryExactRepoDigest(t *testing.T) {
	for _, wrong := range coreUpdateImageNames {
		t.Run(wrong, func(t *testing.T) {
			manifest := pullTestManifest()
			pulled := map[string]bool{}
			runner := &recordingRunner{results: func(args []string) (Result, error) {
				image := args[len(args)-1]
				switch args[0] {
				case "info":
					return Result{Stdout: os.TempDir()}, nil
				case "pull":
					pulled[image] = true
					return Result{}, nil
				case "image":
					if !pulled[image] {
						return Result{ExitCode: 1, Stderr: "No such image"}, errors.New("missing")
					}
					if image == manifest.Images[wrong] {
						return Result{Stdout: fmt.Sprintf("[%q]", "other.example/image@"+strings.Split(image, "@")[1])}, nil
					}
					return Result{Stdout: fmt.Sprintf("[%q]", image)}, nil
				}
				return Result{}, fmt.Errorf("unexpected command %v", args)
			}}
			docker := pullTestDocker(runner, time.Second, 2*time.Second)
			err := docker.Pull(context.Background(), manifest)
			if err == nil || !strings.Contains(err.Error(), "verify pulled managed image "+wrong+": exact RepoDigest is absent") {
				t.Fatalf("wrong repository digest accepted for %s: %v", wrong, err)
			}
		})
	}
}
