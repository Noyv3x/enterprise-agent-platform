package handofftransform

import (
	"context"
	"strings"
	"testing"
)

func TestPreserveExactSubtrees(t *testing.T) {
	validator, err := PreserveExactSubtrees("users/alice", "browser/profile")
	if err != nil {
		t.Fatal(err)
	}
	source := []Entry{
		{Path: ".", Type: Directory},
		{Path: "machine.json", Type: RegularFile, SHA256: strings.Repeat("a", 64), Size: 1},
		{Path: "users/alice", Type: Directory, Mode: 0o700, ModifiedNanos: 1},
		{Path: "users/alice/note.txt", Type: RegularFile, Mode: 0o600, Size: 4, ModifiedNanos: 2, SHA256: strings.Repeat("b", 64)},
		{Path: "browser/profile", Type: Directory, Mode: 0o700, ModifiedNanos: 3},
		{Path: "browser/profile/cookies.sqlite", Type: RegularFile, Mode: 0o600, Size: 8, ModifiedNanos: 4, SHA256: strings.Repeat("c", 64)},
	}
	target := cloneEntries(source)
	target[1].SHA256 = strings.Repeat("d", 64) // declared machine-owned state may change.
	input := ValidationInput{SourceEntries: source, TargetEntries: target}
	if err := validator.Validate(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	target[3].SHA256 = strings.Repeat("e", 64)
	if err := validator.Validate(context.Background(), ValidationInput{SourceEntries: source, TargetEntries: target}); err == nil || !strings.Contains(err.Error(), "note.txt changed") {
		t.Fatalf("changed user content was accepted: %v", err)
	}
}

func TestPreserveExactSubtreesRejectsAmbiguousRules(t *testing.T) {
	for _, paths := range [][]string{{}, {"."}, {"a", "a/b"}, {"../escape"}} {
		if _, err := PreserveExactSubtrees(paths...); err == nil {
			t.Fatalf("ambiguous preserve paths were accepted: %#v", paths)
		}
	}
}

func TestValidatorsRejectsEmptyAndNilMembers(t *testing.T) {
	input := ValidationInput{}
	if err := Validators().Validate(context.Background(), input); err == nil {
		t.Fatal("empty validator set was accepted")
	}
	if err := Validators(nil).Validate(context.Background(), input); err == nil {
		t.Fatal("nil validator was accepted")
	}
}
