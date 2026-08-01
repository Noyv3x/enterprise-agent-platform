//go:build linux

// Package handofffd transfers the Manager's bound TCP listeners over an
// owner-only Unix SOCK_SEQPACKET channel. The sender keeps its original
// listeners; only duplicated descriptors cross SCM_RIGHTS.
package handofffd

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	SchemaVersion = 1

	// Each transfer direction owns a distinct pathname for the full
	// transaction. A pathname is never recycled for another role: doing so
	// would make an inode-checked connection vulnerable to a pathname ABA.
	SourceToHelperSocketBasename = "source-to-helper.listeners.sock"
	HelperToTargetSocketBasename = "helper-to-target.listeners.sock"
	HelperToSourceSocketBasename = "helper-to-source.listeners.sock"

	maxPayload   = 4096
	maxListeners = 2
)

var transactionPattern = regexp.MustCompile(`^handoff_[0-9a-f]{32}$`)
var shaPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

var ErrPostAdoptionAcknowledgement = errors.New("listener ownership was adopted but transfer acknowledgement is uncertain")

type NamedListener struct {
	Name     string
	Listener net.Listener
}

// ListenerIdentity is the canonical, descriptor-independent identity used to
// bind a transfer to the journal-derived public addresses.
type ListenerIdentity struct {
	Name    string `json:"name"`
	Address string `json:"address"`
}

type envelope struct {
	SchemaVersion int                `json:"schema_version"`
	TransactionID string             `json:"transaction_id"`
	Listeners     []ListenerIdentity `json:"listeners"`
}

type acknowledgement struct {
	SchemaVersion  int    `json:"schema_version"`
	TransactionID  string `json:"transaction_id"`
	Status         string `json:"status"`
	EnvelopeSHA256 string `json:"envelope_sha256"`
}

type Receiver struct {
	listener  *net.UnixListener
	path      string
	address   string
	directory *directoryHandle
	identity  socketIdentity
	close     sync.Once
	closeErr  error
}

type socketIdentity struct {
	device uint64
	inode  uint64
	uid    uint32
}

// Listen binds the fixed transfer socket inside an already secured handoff
// transaction directory. It never removes an existing pathname.
func Listen(path string) (*Receiver, error) {
	if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path || !validSocketBasename(filepath.Base(path)) {
		return nil, errors.New("listener transfer socket path is invalid")
	}
	return ListenAt(filepath.Dir(path), filepath.Base(path))
}

// ListenAt binds through a short /proc/self/fd address while retaining the
// securely opened transaction directory. This avoids AF_UNIX's 107-byte
// sockaddr limit without moving the socket outside its journal directory.
func ListenAt(directoryPath, basename string) (*Receiver, error) {
	return listenAt(directoryPath, basename, false)
}

// ListenAtRecovering is the crash-replay variant. It removes a prior socket
// inode only when an anchored connect returns exactly ECONNREFUSED and the
// directory and socket identities remain unchanged. Live or ambiguous paths
// are never removed.
func ListenAtRecovering(directoryPath, basename string) (*Receiver, error) {
	return listenAt(directoryPath, basename, true)
}

func listenAt(directoryPath, basename string, recoverStale bool) (*Receiver, error) {
	if !validSocketBasename(basename) {
		return nil, errors.New("listener transfer socket role is invalid")
	}
	directory, err := openDirectory(directoryPath)
	if err != nil {
		return nil, err
	}
	cleanupDirectory := true
	defer func() {
		if cleanupDirectory {
			_ = directory.Close()
		}
	}()
	address := directory.childAddress(basename)
	logicalPath := filepath.Join(directoryPath, basename)
	if _, err := os.Lstat(address); !os.IsNotExist(err) {
		if err != nil {
			return nil, err
		}
		if !recoverStale {
			return nil, errors.New("listener transfer socket path already exists")
		}
		if err := removeStaleSocket(directory, address); err != nil {
			return nil, err
		}
	}
	listener, err := net.ListenUnix("unixpacket", &net.UnixAddr{Name: address, Net: "unixpacket"})
	if err != nil {
		return nil, err
	}
	listener.SetUnlinkOnClose(false)
	cleanup := true
	defer func() {
		if cleanup {
			_ = listener.Close()
			_ = os.Remove(address)
		}
	}()
	if err := os.Chmod(address, 0o600); err != nil {
		return nil, err
	}
	identity, err := inspectSocket(address)
	if err != nil {
		return nil, err
	}
	if identity.uid != uint32(os.Getuid()) {
		return nil, errors.New("listener transfer socket has an unexpected owner")
	}
	cleanup = false
	cleanupDirectory = false
	return &Receiver{listener: listener, path: logicalPath, address: address, directory: directory, identity: identity}, nil
}

func removeStaleSocket(directory *directoryHandle, address string) error {
	wanted, err := inspectSocket(address)
	if err != nil || wanted.uid != uint32(os.Getuid()) {
		return errors.New("existing listener transfer path is not an owned secured socket")
	}
	connection, dialErr := net.DialTimeout("unixpacket", address, 100*time.Millisecond)
	if dialErr == nil {
		_ = connection.Close()
		return errors.New("listener transfer socket already has a live owner")
	}
	if !errors.Is(dialErr, syscall.ECONNREFUSED) {
		return fmt.Errorf("listener transfer socket liveness is ambiguous: %w", dialErr)
	}
	if err := directory.validate(); err != nil {
		return err
	}
	actual, err := inspectSocket(address)
	if err != nil || actual != wanted {
		return errors.New("listener transfer socket identity changed during stale probe")
	}
	if err := os.Remove(address); err != nil {
		return fmt.Errorf("remove stale listener transfer socket: %w", err)
	}
	if err := directory.file.Sync(); err != nil {
		return fmt.Errorf("sync listener transfer directory after stale removal: %w", err)
	}
	return nil
}

func (receiver *Receiver) Accept(ctx context.Context, transactionID string) ([]NamedListener, error) {
	return receiver.AcceptExact(ctx, transactionID, nil)
}

// AcceptExact receives one packet and acknowledges it only after the actual
// descriptors match the supplied canonical journal-derived identities. A nil
// expected slice is retained for the low-level protocol tests; production
// handoff users must always pass the exact non-empty set.
func (receiver *Receiver) AcceptExact(ctx context.Context, transactionID string, expected []ListenerIdentity) ([]NamedListener, error) {
	return receiver.acceptExact(ctx, transactionID, expected, nil)
}

// AcceptExactWithAdoption validates the complete transfer, lets the
// participant atomically install the listeners in its gateway, and only then
// acknowledges the sender. Once adopt succeeds, the callback owns the
// listeners even if acknowledgement is uncertain; callers must keep serving
// and let the sender reconcile authenticated participant ownership.
func (receiver *Receiver) AcceptExactWithAdoption(ctx context.Context, transactionID string, expected []ListenerIdentity, adopt func([]NamedListener) error) ([]NamedListener, error) {
	if adopt == nil {
		return nil, errors.New("listener transfer adoption callback is required")
	}
	return receiver.acceptExact(ctx, transactionID, expected, adopt)
}

func (receiver *Receiver) acceptExact(ctx context.Context, transactionID string, expected []ListenerIdentity, adopt func([]NamedListener) error) ([]NamedListener, error) {
	if receiver == nil || receiver.listener == nil {
		return nil, errors.New("listener transfer receiver is unavailable")
	}
	if !transactionPattern.MatchString(transactionID) {
		return nil, errors.New("listener transfer transaction id is invalid")
	}
	if err := receiver.validatePath(); err != nil {
		return nil, err
	}
	stopAcceptDeadline, err := armContextDeadline(receiver.listener, ctx)
	if err != nil {
		return nil, err
	}
	defer stopAcceptDeadline()
	connection, err := receiver.listener.AcceptUnix()
	if err != nil {
		return nil, contextError(ctx, err)
	}
	defer connection.Close()
	if err := receiver.validatePath(); err != nil {
		return nil, err
	}
	if err := verifyPeer(connection); err != nil {
		return nil, err
	}
	stopConnectionDeadline, err := armContextDeadline(connection, ctx)
	if err != nil {
		return nil, err
	}
	defer stopConnectionDeadline()
	listeners, payload, err := receivePacket(connection, transactionID, expected)
	if err != nil {
		return nil, err
	}
	adopted := false
	if adopt != nil {
		if err := adopt(listeners); err != nil {
			closeListeners(listeners)
			return nil, fmt.Errorf("adopt transferred listeners: %w", err)
		}
		adopted = true
	}
	hash := sha256.Sum256(payload)
	ack := acknowledgement{
		SchemaVersion: SchemaVersion, TransactionID: transactionID, Status: "accepted",
		EnvelopeSHA256: hex.EncodeToString(hash[:]),
	}
	encoded, err := json.Marshal(ack)
	if err != nil {
		if !adopted {
			closeListeners(listeners)
		}
		return nil, err
	}
	written, oobWritten, err := connection.WriteMsgUnix(encoded, nil, nil)
	if err != nil || written != len(encoded) || oobWritten != 0 {
		if !adopted {
			closeListeners(listeners)
		}
		if err == nil {
			err = io.ErrShortWrite
		}
		ackErr := fmt.Errorf("acknowledge listener transfer: %w", contextError(ctx, err))
		if adopted {
			return listeners, errors.Join(ErrPostAdoptionAcknowledgement, ackErr)
		}
		return nil, ackErr
	}
	return listeners, nil
}

// Send duplicates and transfers the supplied listeners, then waits for an
// acknowledgement bound to the exact envelope. The original listeners remain
// open regardless of the outcome.
func Send(ctx context.Context, path, transactionID string, listeners []NamedListener) error {
	if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path || !validSocketBasename(filepath.Base(path)) {
		return errors.New("listener transfer socket path is invalid")
	}
	return SendAt(ctx, filepath.Dir(path), filepath.Base(path), transactionID, listeners)
}

// SendAt connects through a short /proc/self/fd address anchored to a
// securely opened transaction directory retained through acknowledgement.
func SendAt(ctx context.Context, directoryPath, basename, transactionID string, listeners []NamedListener) error {
	if !validSocketBasename(basename) {
		return errors.New("listener transfer socket role is invalid")
	}
	if !transactionPattern.MatchString(transactionID) {
		return errors.New("listener transfer transaction id is invalid")
	}
	directory, err := openDirectory(directoryPath)
	if err != nil {
		return err
	}
	defer directory.Close()
	address := directory.childAddress(basename)
	wantedSocket, err := inspectSocket(address)
	if err != nil || wantedSocket.uid != uint32(os.Getuid()) {
		return errors.New("listener transfer socket is not owned by the Manager user")
	}
	identities, files, err := prepareListeners(listeners)
	if err != nil {
		return err
	}
	defer closeFiles(files)
	message := envelope{SchemaVersion: SchemaVersion, TransactionID: transactionID, Listeners: identities}
	payload, err := json.Marshal(message)
	if err != nil {
		return err
	}
	hash := sha256.Sum256(payload)

	dialer := net.Dialer{}
	raw, err := dialer.DialContext(ctx, "unixpacket", address)
	if err != nil {
		return err
	}
	connection, ok := raw.(*net.UnixConn)
	if !ok {
		_ = raw.Close()
		return errors.New("listener transfer did not create a Unix packet connection")
	}
	defer connection.Close()
	actualSocket, inspectErr := inspectSocket(address)
	if inspectErr != nil || actualSocket != wantedSocket || directory.validate() != nil {
		return errors.New("listener transfer socket path identity changed while connecting")
	}
	if err := verifyPeer(connection); err != nil {
		return err
	}
	stopConnectionDeadline, err := armContextDeadline(connection, ctx)
	if err != nil {
		return err
	}
	defer stopConnectionDeadline()
	fds := make([]int, len(files))
	for index, file := range files {
		fds[index] = int(file.Fd())
	}
	rights := syscall.UnixRights(fds...)
	written, oobWritten, err := connection.WriteMsgUnix(payload, rights, nil)
	if err != nil || written != len(payload) || oobWritten != len(rights) {
		if err == nil {
			err = io.ErrShortWrite
		}
		return fmt.Errorf("send listener transfer: %w", contextError(ctx, err))
	}
	return readAcknowledgement(connection, transactionID, hex.EncodeToString(hash[:]), ctx)
}

func prepareListeners(values []NamedListener) ([]ListenerIdentity, []*os.File, error) {
	if len(values) < 1 || len(values) > maxListeners {
		return nil, nil, errors.New("listener transfer requires one or two listeners")
	}
	values = append([]NamedListener(nil), values...)
	sort.Slice(values, func(first, second int) bool { return values[first].Name < values[second].Name })
	primary := 0
	identities := make([]ListenerIdentity, 0, len(values))
	files := make([]*os.File, 0, len(values))
	defer func() {
		if identities == nil {
			closeFiles(files)
		}
	}()
	previous := ""
	for _, value := range values {
		if value.Name != "primary" && value.Name != "lan" {
			identities = nil
			return nil, nil, errors.New("listener transfer contains an unknown listener name")
		}
		if value.Name == previous {
			identities = nil
			return nil, nil, errors.New("listener transfer contains a duplicate listener name")
		}
		previous = value.Name
		if value.Name == "primary" {
			primary++
		}
		tcp, ok := value.Listener.(*net.TCPListener)
		if !ok || tcp == nil {
			identities = nil
			return nil, nil, errors.New("listener transfer accepts only TCP listeners")
		}
		if err := requireAcceptingTCPListener(tcp); err != nil {
			identities = nil
			return nil, nil, err
		}
		address, err := canonicalTCPAddress(tcp.Addr())
		if err != nil {
			identities = nil
			return nil, nil, err
		}
		file, err := tcp.File()
		if err != nil {
			identities = nil
			return nil, nil, err
		}
		files = append(files, file)
		identities = append(identities, ListenerIdentity{Name: value.Name, Address: address})
	}
	if primary != 1 {
		identities = nil
		return nil, nil, errors.New("listener transfer requires exactly one primary listener")
	}
	return identities, files, nil
}

func receivePacket(connection *net.UnixConn, transactionID string, expected []ListenerIdentity) ([]NamedListener, []byte, error) {
	payload := make([]byte, maxPayload+1)
	oob := make([]byte, syscall.CmsgSpace(maxListeners*4))
	count, oobCount, flags, _, err := connection.ReadMsgUnix(payload, oob)
	if err != nil {
		return nil, nil, err
	}
	if flags&(syscall.MSG_TRUNC|syscall.MSG_CTRUNC) != 0 || count <= 0 || count > maxPayload {
		closeRights(oob[:oobCount])
		return nil, nil, errors.New("listener transfer packet was truncated or oversized")
	}
	fds, err := parseRights(oob[:oobCount])
	if err != nil {
		return nil, nil, err
	}
	keepFDs := false
	defer func() {
		if !keepFDs {
			closeFDs(fds)
		}
	}()
	var message envelope
	decoder := json.NewDecoder(bytes.NewReader(payload[:count]))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&message); err != nil {
		return nil, nil, fmt.Errorf("decode listener transfer envelope: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, nil, errors.New("listener transfer envelope contains trailing JSON")
	}
	canonical, err := json.Marshal(message)
	if err != nil || !bytes.Equal(canonical, payload[:count]) {
		return nil, nil, errors.New("listener transfer envelope is not canonical")
	}
	if message.SchemaVersion != SchemaVersion || message.TransactionID != transactionID || len(message.Listeners) != len(fds) || len(fds) < 1 || len(fds) > maxListeners {
		return nil, nil, errors.New("listener transfer envelope does not match its descriptors")
	}
	if expected != nil {
		canonicalExpected, err := ValidateIdentities(expected)
		if err != nil || !identitiesEqual(message.Listeners, canonicalExpected) {
			return nil, nil, errors.New("listener transfer envelope does not match the journal-bound listeners")
		}
	}
	listeners := make([]NamedListener, 0, len(fds))
	defer func() {
		if !keepFDs {
			closeListeners(listeners)
		}
	}()
	primary := 0
	previous := ""
	for index, identity := range message.Listeners {
		if identity.Name != "primary" && identity.Name != "lan" || identity.Name <= previous {
			return nil, nil, errors.New("listener transfer names are unknown, duplicated, or unsorted")
		}
		previous = identity.Name
		if identity.Name == "primary" {
			primary++
		}
		if _, err := parseCanonicalTCPAddress(identity.Address); err != nil {
			return nil, nil, err
		}
		syscall.CloseOnExec(fds[index])
		file := os.NewFile(uintptr(fds[index]), identity.Name+"-listener")
		if file == nil {
			return nil, nil, errors.New("listener transfer received an invalid descriptor")
		}
		listener, err := net.FileListener(file)
		_ = file.Close()
		fds[index] = -1
		if err != nil {
			return nil, nil, fmt.Errorf("open transferred listener: %w", err)
		}
		tcp, ok := listener.(*net.TCPListener)
		if !ok {
			_ = listener.Close()
			return nil, nil, errors.New("transferred descriptor is not a TCP listener")
		}
		if err := requireAcceptingTCPListener(tcp); err != nil {
			_ = listener.Close()
			return nil, nil, err
		}
		actual, err := canonicalTCPAddress(tcp.Addr())
		if err != nil || actual != identity.Address {
			_ = listener.Close()
			return nil, nil, errors.New("transferred listener address does not match its envelope")
		}
		listeners = append(listeners, NamedListener{Name: identity.Name, Listener: listener})
	}
	if primary != 1 {
		return nil, nil, errors.New("listener transfer requires exactly one primary listener")
	}
	keepFDs = true
	return listeners, canonical, nil
}

func readAcknowledgement(connection *net.UnixConn, transactionID, envelopeSHA string, ctx context.Context) error {
	payload := make([]byte, maxPayload+1)
	oob := make([]byte, syscall.CmsgSpace(maxListeners*4))
	count, oobCount, flags, _, err := connection.ReadMsgUnix(payload, oob)
	if err != nil {
		return contextError(ctx, err)
	}
	if oobCount != 0 {
		closeRights(oob[:oobCount])
		return errors.New("listener transfer acknowledgement unexpectedly contained descriptors")
	}
	if flags&(syscall.MSG_TRUNC|syscall.MSG_CTRUNC) != 0 || count <= 0 || count > maxPayload {
		return errors.New("listener transfer acknowledgement was truncated or oversized")
	}
	var ack acknowledgement
	decoder := json.NewDecoder(bytes.NewReader(payload[:count]))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&ack); err != nil {
		return fmt.Errorf("decode listener transfer acknowledgement: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("listener transfer acknowledgement contains trailing JSON")
	}
	canonical, err := json.Marshal(ack)
	if err != nil || !bytes.Equal(canonical, payload[:count]) {
		return errors.New("listener transfer acknowledgement is not canonical")
	}
	if ack.SchemaVersion != SchemaVersion || ack.TransactionID != transactionID || ack.Status != "accepted" ||
		!shaPattern.MatchString(ack.EnvelopeSHA256) || ack.EnvelopeSHA256 != envelopeSHA {
		return errors.New("listener transfer acknowledgement does not match the sent envelope")
	}
	return nil
}

func parseRights(oob []byte) ([]int, error) {
	messages, err := syscall.ParseSocketControlMessage(oob)
	if err != nil {
		closeRights(oob)
		return nil, fmt.Errorf("parse listener transfer control message: %w", err)
	}
	if len(messages) != 1 || messages[0].Header.Level != syscall.SOL_SOCKET || messages[0].Header.Type != syscall.SCM_RIGHTS {
		closeRights(oob)
		return nil, errors.New("listener transfer requires exactly one SCM_RIGHTS control message")
	}
	fds, err := syscall.ParseUnixRights(&messages[0])
	if err != nil || len(fds) < 1 || len(fds) > maxListeners {
		closeFDs(fds)
		return nil, errors.New("listener transfer descriptor count is invalid")
	}
	return fds, nil
}

func closeRights(oob []byte) {
	messages, err := syscall.ParseSocketControlMessage(oob)
	if err != nil {
		return
	}
	for index := range messages {
		fds, _ := syscall.ParseUnixRights(&messages[index])
		closeFDs(fds)
	}
}

func verifyPeer(connection *net.UnixConn) error {
	raw, err := connection.SyscallConn()
	if err != nil {
		return err
	}
	var credentials *syscall.Ucred
	var controlErr error
	if err := raw.Control(func(fd uintptr) {
		credentials, controlErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil {
		return err
	}
	if controlErr != nil {
		return controlErr
	}
	if credentials == nil || credentials.Uid != uint32(os.Getuid()) {
		return errors.New("listener transfer peer UID does not match the Manager owner")
	}
	return nil
}

func requireAcceptingTCPListener(listener *net.TCPListener) error {
	if listener == nil {
		return errors.New("transferred TCP descriptor is unavailable")
	}
	raw, err := listener.SyscallConn()
	if err != nil {
		return fmt.Errorf("inspect transferred TCP descriptor: %w", err)
	}
	accepting := 0
	var socketErr error
	if err := raw.Control(func(fd uintptr) {
		accepting, socketErr = syscall.GetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_ACCEPTCONN)
	}); err != nil {
		return fmt.Errorf("inspect transferred TCP descriptor: %w", err)
	}
	if socketErr != nil {
		return fmt.Errorf("inspect transferred TCP descriptor: %w", socketErr)
	}
	if accepting != 1 {
		return errors.New("transferred TCP descriptor is not accepting connections")
	}
	return nil
}

func canonicalTCPAddress(address net.Addr) (string, error) {
	tcp, ok := address.(*net.TCPAddr)
	if !ok || tcp == nil || tcp.IP == nil || tcp.Port < 1 || tcp.Port > 65535 || tcp.Zone != "" {
		return "", errors.New("listener transfer TCP address is invalid")
	}
	value, ok := netip.AddrFromSlice(tcp.IP)
	if !ok {
		return "", errors.New("listener transfer TCP address is invalid")
	}
	return netip.AddrPortFrom(value.Unmap(), uint16(tcp.Port)).String(), nil
}

func parseCanonicalTCPAddress(value string) (netip.AddrPort, error) {
	if strings.TrimSpace(value) != value {
		return netip.AddrPort{}, errors.New("listener transfer TCP address is not canonical")
	}
	address, err := netip.ParseAddrPort(value)
	if err != nil || !address.IsValid() || address.Port() == 0 || address.Addr().Zone() != "" || address.String() != value {
		return netip.AddrPort{}, errors.New("listener transfer TCP address is not canonical")
	}
	return address, nil
}

func validateDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || stat.Uid != uint32(os.Getuid()) || info.Mode().Perm() != 0o700 {
		return errors.New("listener transfer directory must be an owner-owned 0700 non-symlink directory")
	}
	return nil
}

func inspectSocket(path string) (socketIdentity, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return socketIdentity{}, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || info.Mode()&os.ModeType != os.ModeSocket || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o600 {
		return socketIdentity{}, errors.New("listener transfer path is not a secured Unix socket")
	}
	return socketIdentity{device: uint64(stat.Dev), inode: uint64(stat.Ino), uid: stat.Uid}, nil
}

func (receiver *Receiver) validatePath() error {
	if receiver.directory == nil || receiver.directory.validate() != nil {
		return errors.New("listener transfer directory identity changed")
	}
	actual, err := inspectSocket(receiver.address)
	if err != nil || actual != receiver.identity {
		return errors.New("listener transfer socket path identity changed")
	}
	return nil
}

func (receiver *Receiver) Close() error {
	if receiver == nil {
		return nil
	}
	receiver.close.Do(func() {
		if receiver.listener != nil {
			receiver.closeErr = receiver.listener.Close()
		}
		if actual, err := inspectSocket(receiver.address); err == nil && actual == receiver.identity {
			if removeErr := os.Remove(receiver.address); receiver.closeErr == nil {
				receiver.closeErr = removeErr
			}
		}
		if receiver.directory != nil {
			if closeErr := receiver.directory.Close(); receiver.closeErr == nil {
				receiver.closeErr = closeErr
			}
			receiver.directory = nil
		}
	})
	return receiver.closeErr
}

func armContextDeadline(value interface{ SetDeadline(time.Time) error }, ctx context.Context) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if deadline, ok := ctx.Deadline(); ok {
		if err := value.SetDeadline(deadline); err != nil {
			return nil, err
		}
	}
	if ctx.Done() == nil {
		return func() { _ = value.SetDeadline(time.Time{}) }, nil
	}
	stopped := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		select {
		case <-ctx.Done():
			_ = value.SetDeadline(time.Now())
		case <-stopped:
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			close(stopped)
			<-done
			_ = value.SetDeadline(time.Time{})
		})
	}, nil
}

func validSocketBasename(value string) bool {
	switch value {
	case SourceToHelperSocketBasename, HelperToTargetSocketBasename, HelperToSourceSocketBasename:
		return true
	default:
		return false
	}
}

// Describe validates and returns the exact canonical identities of a set of
// live TCP listeners without transferring or closing them.
func Describe(values []NamedListener) ([]ListenerIdentity, error) {
	identities, files, err := prepareListeners(values)
	closeFiles(files)
	return identities, err
}

// ValidateIdentities validates, copies, and canonically sorts an expected
// primary plus optional LAN identity set.
func ValidateIdentities(values []ListenerIdentity) ([]ListenerIdentity, error) {
	if len(values) < 1 || len(values) > maxListeners {
		return nil, errors.New("listener identity set requires one or two listeners")
	}
	result := append([]ListenerIdentity(nil), values...)
	sort.Slice(result, func(first, second int) bool { return result[first].Name < result[second].Name })
	primary := 0
	previous := ""
	for _, value := range result {
		if value.Name != "primary" && value.Name != "lan" {
			return nil, errors.New("listener identity set contains an unknown name")
		}
		if value.Name == previous {
			return nil, errors.New("listener identity set contains a duplicate name")
		}
		previous = value.Name
		if value.Name == "primary" {
			primary++
		}
		if _, err := parseCanonicalTCPAddress(value.Address); err != nil {
			return nil, err
		}
	}
	if primary != 1 {
		return nil, errors.New("listener identity set requires exactly one primary listener")
	}
	return result, nil
}

func identitiesEqual(left, right []ListenerIdentity) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

type directoryHandle struct {
	file   *os.File
	path   string
	device uint64
	inode  uint64
	uid    uint32
}

func openDirectory(path string) (*directoryHandle, error) {
	if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errors.New("listener transfer directory path is invalid")
	}
	components := strings.Split(strings.TrimPrefix(path, "/"), "/")
	fd, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	for _, component := range components {
		if component == "" || component == "." || component == ".." {
			_ = syscall.Close(fd)
			return nil, errors.New("listener transfer directory path is not canonical")
		}
		next, openErr := syscall.Openat(fd, component, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
		_ = syscall.Close(fd)
		if openErr != nil {
			return nil, openErr
		}
		fd = next
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		_ = syscall.Close(fd)
		return nil, errors.New("listener transfer directory descriptor is invalid")
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || stat.Uid != uint32(os.Getuid()) || info.Mode().Perm() != 0o700 {
		_ = file.Close()
		return nil, errors.New("listener transfer directory must be an owner-owned 0700 directory")
	}
	handle := &directoryHandle{file: file, path: path, device: uint64(stat.Dev), inode: stat.Ino, uid: stat.Uid}
	if err := handle.validate(); err != nil {
		_ = file.Close()
		return nil, err
	}
	return handle, nil
}

func (directory *directoryHandle) childAddress(basename string) string {
	return "/proc/self/fd/" + strconv.FormatUint(uint64(directory.file.Fd()), 10) + "/" + basename
}

func (directory *directoryHandle) validate() error {
	if directory == nil || directory.file == nil {
		return errors.New("listener transfer directory is closed")
	}
	info, err := directory.file.Stat()
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || uint64(stat.Dev) != directory.device || stat.Ino != directory.inode || stat.Uid != directory.uid || info.Mode().Perm() != 0o700 {
		return errors.New("listener transfer directory descriptor identity changed")
	}
	reopened, err := openDirectoryForIdentity(directory.path)
	if err != nil {
		return errors.New("listener transfer directory path identity changed")
	}
	defer reopened.Close()
	reopenedInfo, err := reopened.Stat()
	if err != nil {
		return err
	}
	reopenedStat, ok := reopenedInfo.Sys().(*syscall.Stat_t)
	if !ok || uint64(reopenedStat.Dev) != directory.device || reopenedStat.Ino != directory.inode {
		return errors.New("listener transfer directory path identity changed")
	}
	return nil
}

func openDirectoryForIdentity(path string) (*os.File, error) {
	components := strings.Split(strings.TrimPrefix(path, "/"), "/")
	fd, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	for _, component := range components {
		next, openErr := syscall.Openat(fd, component, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
		_ = syscall.Close(fd)
		if openErr != nil {
			return nil, openErr
		}
		fd = next
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		_ = syscall.Close(fd)
		return nil, errors.New("listener transfer directory descriptor is invalid")
	}
	return file, nil
}

func (directory *directoryHandle) Close() error {
	if directory == nil || directory.file == nil {
		return nil
	}
	err := directory.file.Close()
	directory.file = nil
	return err
}

func contextError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

func closeFDs(fds []int) {
	for _, fd := range fds {
		if fd >= 0 {
			_ = syscall.Close(fd)
		}
	}
}

func closeFiles(files []*os.File) {
	for _, file := range files {
		if file != nil {
			_ = file.Close()
		}
	}
}

func closeListeners(listeners []NamedListener) {
	for _, listener := range listeners {
		if listener.Listener != nil {
			_ = listener.Listener.Close()
		}
	}
}
