//go:build linux

package handofffd

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"testing"
	"time"
)

const testTransaction = "handoff_0123456789abcdef0123456789abcdef"

func testTCPListener(t *testing.T) *net.TCPListener {
	t.Helper()
	listener, err := net.ListenTCP("tcp", &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	return listener
}

func testReceiver(t *testing.T) (*Receiver, string) {
	t.Helper()
	root, err := os.MkdirTemp("", "handofffd-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	directory := filepath.Join(root, "transaction")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, SourceToHelperSocketBasename)
	receiver, err := Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = receiver.Close() })
	return receiver, path
}

func TestTransferOneListenerAndKeepOriginalOpen(t *testing.T) {
	receiver, path := testReceiver(t)
	original := testTCPListener(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	type result struct {
		listeners []NamedListener
		err       error
	}
	accepted := make(chan result, 1)
	go func() {
		listeners, err := receiver.Accept(ctx, testTransaction)
		accepted <- result{listeners: listeners, err: err}
	}()
	if err := Send(ctx, path, testTransaction, []NamedListener{{Name: "primary", Listener: original}}); err != nil {
		t.Fatal(err)
	}
	got := <-accepted
	if got.err != nil || len(got.listeners) != 1 || got.listeners[0].Name != "primary" {
		t.Fatalf("unexpected transferred listeners: %#v err=%v", got.listeners, got.err)
	}
	defer closeListeners(got.listeners)

	transferred := got.listeners[0].Listener.(*net.TCPListener)
	if err := transferred.SetDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	client, err := net.DialTimeout("tcp", original.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	connection, err := transferred.Accept()
	if err != nil {
		t.Fatal(err)
	}
	_ = connection.Close()
	_ = client.Close()

	// Closing the transferred duplicate must not close the source listener.
	_ = transferred.Close()
	if err := original.SetDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	client, err = net.DialTimeout("tcp", original.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	connection, err = original.Accept()
	if err != nil {
		t.Fatal(err)
	}
	_ = connection.Close()
	_ = client.Close()
}

func TestTransferSortsTwoNamedListenersAndMatchesAddresses(t *testing.T) {
	receiver, path := testReceiver(t)
	primary := testTCPListener(t)
	lan := testTCPListener(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	accepted := make(chan []NamedListener, 1)
	errorsChannel := make(chan error, 1)
	go func() {
		listeners, err := receiver.Accept(ctx, testTransaction)
		if err != nil {
			errorsChannel <- err
			return
		}
		accepted <- listeners
	}()
	if err := Send(ctx, path, testTransaction, []NamedListener{
		{Name: "primary", Listener: primary},
		{Name: "lan", Listener: lan},
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-errorsChannel:
		t.Fatal(err)
	case listeners := <-accepted:
		defer closeListeners(listeners)
		names := []string{listeners[0].Name, listeners[1].Name}
		if !sort.StringsAreSorted(names) || strings.Join(names, ",") != "lan,primary" {
			t.Fatalf("listeners are not canonically ordered: %v", names)
		}
		want := map[string]string{"lan": lan.Addr().String(), "primary": primary.Addr().String()}
		for _, listener := range listeners {
			if listener.Listener.Addr().String() != want[listener.Name] {
				t.Fatalf("listener %s address=%s want=%s", listener.Name, listener.Listener.Addr(), want[listener.Name])
			}
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func TestSendRejectsInvalidSetBeforeConnecting(t *testing.T) {
	primary := testTCPListener(t)
	for name, listeners := range map[string][]NamedListener{
		"missing-primary": {{Name: "lan", Listener: primary}},
		"unknown":         {{Name: "other", Listener: primary}},
		"duplicate":       {{Name: "primary", Listener: primary}, {Name: "primary", Listener: primary}},
	} {
		t.Run(name, func(t *testing.T) {
			err := Send(context.Background(), filepath.Join(t.TempDir(), SourceToHelperSocketBasename), testTransaction, listeners)
			if err == nil {
				t.Fatal("invalid listener set was accepted")
			}
		})
	}
}

func TestReceiverRejectsNonCanonicalEnvelopeAndClosesDescriptors(t *testing.T) {
	receiver, path := testReceiver(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		_, err := receiver.Accept(ctx, testTransaction)
		result <- err
	}()

	connection, err := net.DialUnix("unixpacket", nil, &net.UnixAddr{Name: path, Net: "unixpacket"})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	listener := testTCPListener(t)
	file, err := listener.File()
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	// Leading whitespace makes the otherwise valid closed object non-canonical.
	payload := []byte(` {"schema_version":1,"transaction_id":"` + testTransaction + `","listeners":[{"name":"primary","address":"` + listener.Addr().String() + `"}]}`)
	if _, _, err := connection.WriteMsgUnix(payload, unixRights(int(file.Fd())), nil); err != nil {
		t.Fatal(err)
	}
	if err := <-result; err == nil || !strings.Contains(err.Error(), "not canonical") {
		t.Fatalf("non-canonical envelope result: %v", err)
	}
}

func TestReceiverRejectsBoundTCPDescriptorThatIsNotListening(t *testing.T) {
	receiver, path := testReceiver(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		_, err := receiver.Accept(ctx, testTransaction)
		result <- err
	}()

	connection, err := net.DialUnix("unixpacket", nil, &net.UnixAddr{Name: path, Net: "unixpacket"})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, syscall.IPPROTO_TCP)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.Close(fd)
	if err := syscall.Bind(fd, &syscall.SockaddrInet4{Port: 0, Addr: [4]byte{127, 0, 0, 1}}); err != nil {
		t.Fatal(err)
	}
	address, err := syscall.Getsockname(fd)
	if err != nil {
		t.Fatal(err)
	}
	port := address.(*syscall.SockaddrInet4).Port
	payload := []byte(`{"schema_version":1,"transaction_id":"` + testTransaction + `","listeners":[{"name":"primary","address":"127.0.0.1:` + fmt.Sprint(port) + `"}]}`)
	if _, _, err := connection.WriteMsgUnix(payload, unixRights(fd), nil); err != nil {
		t.Fatal(err)
	}
	if err := <-result; err == nil || !strings.Contains(err.Error(), "not accepting") {
		t.Fatalf("non-listening TCP descriptor result: %v", err)
	}
}

func TestCloseDoesNotRemoveReplacementPath(t *testing.T) {
	receiver, path := testReceiver(t)
	originalPath := path + ".old"
	if err := os.Rename(path, originalPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := receiver.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "replacement" {
		t.Fatalf("receiver removed a replacement path: data=%q err=%v", data, err)
	}
}

func TestAcceptCancellationWithoutDeadlineInterruptsPacketWait(t *testing.T) {
	receiver, _ := testReceiver(t)
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := receiver.Accept(ctx, testTransaction)
		result <- err
	}()
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Accept cancellation = %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Accept ignored context cancellation without a deadline")
	}
}

func TestSendCancellationWithoutDeadlineInterruptsAcknowledgementWait(t *testing.T) {
	_, path := testReceiver(t)
	listener := testTCPListener(t)
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		result <- Send(ctx, path, testTransaction, []NamedListener{{Name: "primary", Listener: listener}})
	}()
	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Send cancellation = %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Send ignored context cancellation without a deadline")
	}
}

func TestAcceptExactRejectsAddressMismatchBeforeAcknowledgement(t *testing.T) {
	receiver, path := testReceiver(t)
	listener := testTCPListener(t)
	other := testTCPListener(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	received := make(chan error, 1)
	go func() {
		_, err := receiver.AcceptExact(ctx, testTransaction, []ListenerIdentity{{Name: "primary", Address: other.Addr().String()}})
		received <- err
	}()
	err := Send(ctx, path, testTransaction, []NamedListener{{Name: "primary", Listener: listener}})
	if err == nil {
		t.Fatal("sender received an acknowledgement for a non-journal address")
	}
	if err := <-received; err == nil || !strings.Contains(err.Error(), "journal-bound") {
		t.Fatalf("exact receiver mismatch = %v", err)
	}
}

func TestLongTransactionPathUsesAnchoredProcFDAddress(t *testing.T) {
	root := t.TempDir()
	directory := root
	for index := 0; index < 4; index++ {
		directory = filepath.Join(directory, strings.Repeat(string(rune('a'+index)), 35))
		if err := os.Mkdir(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if len(filepath.Join(directory, SourceToHelperSocketBasename)) <= 107 {
		t.Fatal("test did not exceed the AF_UNIX pathname limit")
	}
	receiver, err := ListenAt(directory, SourceToHelperSocketBasename)
	if err != nil {
		t.Fatalf("ListenAt long path: %v", err)
	}
	defer receiver.Close()
	listener := testTCPListener(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	received := make(chan error, 1)
	go func() {
		listeners, acceptErr := receiver.AcceptExact(ctx, testTransaction, []ListenerIdentity{{Name: "primary", Address: listener.Addr().String()}})
		closeListeners(listeners)
		received <- acceptErr
	}()
	if err := SendAt(ctx, directory, SourceToHelperSocketBasename, testTransaction, []NamedListener{{Name: "primary", Listener: listener}}); err != nil {
		t.Fatal(err)
	}
	if err := <-received; err != nil {
		t.Fatal(err)
	}
}

func TestRecoveringReceiverRemovesOnlyProvenStaleSocket(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "transaction")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	first, err := ListenAt(directory, SourceToHelperSocketBasename)
	if err != nil {
		t.Fatal(err)
	}
	// Simulate process death: descriptors disappear without the receiver's
	// inode-aware cleanup running.
	if err := first.listener.Close(); err != nil {
		t.Fatal(err)
	}
	if err := first.directory.Close(); err != nil {
		t.Fatal(err)
	}
	first.listener = nil
	first.directory = nil
	second, err := ListenAtRecovering(directory, SourceToHelperSocketBasename)
	if err != nil {
		t.Fatalf("recover proven stale receiver: %v", err)
	}
	defer second.Close()
	if _, err := ListenAtRecovering(directory, SourceToHelperSocketBasename); err == nil || !strings.Contains(err.Error(), "live owner") {
		t.Fatalf("recovering receiver replaced a live socket: %v", err)
	}
}

// Keep direct syscall construction confined to the malicious-peer test.
func unixRights(fd int) []byte { return syscall.UnixRights(fd) }
