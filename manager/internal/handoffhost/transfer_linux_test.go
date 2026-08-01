//go:build linux

package handoffhost

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestListenerTransferUsesTransactionBoundPacketPath(t *testing.T) {
	transactionID := randomTestTransactionID(t)
	transactionDirectory := filepath.Join(shortTempDir(t), transactionID)
	if err := os.Mkdir(transactionDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	host := &LinuxHost{}
	receiver, err := host.OpenListenerReceiver(transactionDirectory, transactionID)
	if err != nil {
		t.Fatal(err)
	}
	defer receiver.Close()
	wantedPath, err := TransferSocketPath(transactionDirectory, transactionID)
	if err != nil {
		t.Fatal(err)
	}
	if receiver.Path() != wantedPath {
		t.Fatalf("receiver path = %q, want %q", receiver.Path(), wantedPath)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	received := make(chan []NamedListener, 1)
	failures := make(chan error, 1)
	go func() {
		listeners, acceptErr := receiver.Accept(ctx)
		if acceptErr != nil {
			failures <- acceptErr
			return
		}
		received <- listeners
	}()
	if err := host.SendListeners(ctx, transactionDirectory, transactionID, []NamedListener{{Name: "primary", Listener: listener}}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-failures:
		t.Fatal(err)
	case listeners := <-received:
		if len(listeners) != 1 || listeners[0].Name != "primary" || listeners[0].Listener.Addr().String() != listener.Addr().String() {
			t.Fatalf("received listeners = %#v", listeners)
		}
		for _, receivedListener := range listeners {
			_ = receivedListener.Listener.Close()
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := receiver.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(wantedPath); !os.IsNotExist(err) {
		t.Fatalf("closed transfer socket still exists: %v", err)
	}
}

func TestTransferSocketPathRejectsAnotherTransactionDirectory(t *testing.T) {
	transactionID := randomTestTransactionID(t)
	if _, err := TransferSocketPath(filepath.Join(shortTempDir(t), "handoff_00000000000000000000000000000000"), transactionID); err == nil {
		t.Fatal("accepted a socket directory belonging to another transaction")
	}
}
