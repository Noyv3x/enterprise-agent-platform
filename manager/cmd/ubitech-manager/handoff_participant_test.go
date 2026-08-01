//go:build linux

package main

import "testing"

func TestValidateParticipantSocketBindingRequiresOneExactAbsoluteTargetSocket(t *testing.T) {
	want := "/run/user/1001/agent-platform-manager/manager.sock"
	if err := validateParticipantSocketBinding(want, want); err != nil {
		t.Fatalf("validate exact target socket: %v", err)
	}
	for name, path := range map[string]string{
		"wrong runtime suffix": "/run/user/1001/other/manager.sock",
		"relative actual":      "run/user/1001/agent-platform-manager/manager.sock",
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateParticipantSocketBinding(want, path); err == nil {
				t.Fatal("expected target socket binding rejection")
			}
		})
	}
	if err := validateParticipantSocketBinding("$XDG_RUNTIME_DIR/agent-platform-manager/manager.sock", want); err == nil {
		t.Fatal("expected unresolved target socket rejection")
	}
}

func TestValidateParticipantSocketBindingRequiresExactAbsoluteSourceSocket(t *testing.T) {
	want := "/home/member/.local/share/source/manager/control/manager.sock"
	if err := validateParticipantSocketBinding(want, want); err != nil {
		t.Fatal(err)
	}
	if err := validateParticipantSocketBinding(want, want+".other"); err == nil {
		t.Fatal("expected absolute source socket mismatch rejection")
	}
}
