//go:build linux

package main

import (
	"net"
	"testing"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/config"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofffd"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/journal"
)

func TestGatewayParticipantWaitsForAndAdoptsExactHandoffListeners(t *testing.T) {
	primary, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	lan, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = primary.Close()
		t.Fatal(err)
	}

	cfg, err := config.Defaults(identity.SourceActiveProfile())
	if err != nil {
		_ = primary.Close()
		_ = lan.Close()
		t.Fatal(err)
	}
	cfg.GatewayAddress = primary.Addr().String()
	cfg.LANEnabled = true
	cfg.LANAddress = lan.Addr().String()
	cfg.PlatformURL = "http://127.0.0.1:18080"
	store, err := journal.Open(t.TempDir(), time.Now())
	if err != nil {
		_ = primary.Close()
		_ = lan.Close()
		t.Fatal(err)
	}
	controller := newGatewayController(&application{
		profile: identity.SourceActiveProfile(), config: cfg,
		configs: config.NewManager(cfg), state: store,
	})
	defer controller.Stop()
	if err := controller.WaitForHandoffListeners(); err != nil {
		t.Fatal(err)
	}
	if err := controller.Start(); err != nil {
		t.Fatalf("waiting Start: %v", err)
	}
	if _, err := controller.CurrentHandoffListeners(); err == nil {
		t.Fatal("waiting participant reported listener ownership")
	}
	if err := controller.AdoptHandoffListeners([]handofffd.NamedListener{
		{Name: "lan", Listener: lan},
		{Name: "primary", Listener: primary},
	}); err != nil {
		t.Fatal(err)
	}
	current, err := controller.CurrentHandoffListeners()
	if err != nil {
		t.Fatal(err)
	}
	if len(current) != 2 || current[0].Name != "lan" || current[0].Listener != lan || current[1].Name != "primary" || current[1].Listener != primary {
		t.Fatalf("unexpected adopted listener set: %#v", current)
	}
}

func TestGatewayParticipantRejectsMismatchedHandoffListener(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	cfg, err := config.Defaults(identity.SourceActiveProfile())
	if err != nil {
		t.Fatal(err)
	}
	cfg.GatewayAddress = "127.0.0.1:1"
	cfg.PlatformURL = "http://127.0.0.1:18080"
	store, err := journal.Open(t.TempDir(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	controller := newGatewayController(&application{
		profile: identity.SourceActiveProfile(), config: cfg,
		configs: config.NewManager(cfg), state: store,
	})
	if err := controller.WaitForHandoffListeners(); err != nil {
		t.Fatal(err)
	}
	if err := controller.AdoptHandoffListeners([]handofffd.NamedListener{{Name: "primary", Listener: listener}}); err == nil {
		t.Fatal("mismatched public address was accepted")
	}
}
