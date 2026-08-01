//go:build linux

// Package handoffcontrol implements the authenticated participant side of
// listener ownership challenges. It is separate from control so the HTTP API
// can depend on the closed-world handoff listener schema without an import
// cycle.
package handoffcontrol

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handoff"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofflisteners"
)

type Endpoint struct {
	// SocketPath is the one canonical absolute value copied from the immutable
	// source/target journal binding and used for the actual connection.
	SocketPath string
	TokenFile  string
	PID        int
	// ProcessAbsent may be true only after the resolver has positively proved
	// the role's journal-bound unit/process is absent.
	ProcessAbsent bool
}

type EndpointResolver interface {
	ResolveOwnershipEndpoint(context.Context, handoff.Journal, handofflisteners.PublicOwner) (Endpoint, error)
}

type EndpointResolverFunc func(context.Context, handoff.Journal, handofflisteners.PublicOwner) (Endpoint, error)

func (function EndpointResolverFunc) ResolveOwnershipEndpoint(ctx context.Context, journal handoff.Journal, role handofflisteners.PublicOwner) (Endpoint, error) {
	return function(ctx, journal, role)
}

type Client struct {
	Resolver EndpointResolver
	Timeout  time.Duration
}

func (client Client) Challenge(ctx context.Context, journal handoff.Journal, role handofflisteners.PublicOwner, challenge handofflisteners.OwnershipChallenge) (handofflisteners.OwnershipProof, error) {
	if client.Resolver == nil {
		return handofflisteners.OwnershipProof{}, errors.New("ownership control endpoint resolver is unavailable")
	}
	if err := handoff.Validate(journal); err != nil {
		return handofflisteners.OwnershipProof{}, fmt.Errorf("validate ownership control journal: %w", err)
	}
	if err := handofflisteners.ValidateOwnershipChallenge(challenge); err != nil {
		return handofflisteners.OwnershipProof{}, err
	}
	if role != challenge.Role || journal.TransactionID != challenge.TransactionID {
		return handofflisteners.OwnershipProof{}, errors.New("ownership challenge is not bound to the requested participant")
	}
	endpoint, err := client.Resolver.ResolveOwnershipEndpoint(ctx, journal, role)
	if err != nil {
		return handofflisteners.OwnershipProof{}, fmt.Errorf("resolve %s ownership control endpoint: %w", role, err)
	}
	if err := validateEndpoint(journal, role, endpoint); err != nil {
		return handofflisteners.OwnershipProof{}, err
	}
	socket, err := openSocket(endpoint.SocketPath)
	if endpoint.ProcessAbsent {
		if os.IsNotExist(err) {
			return handofflisteners.OwnershipProof{}, handofflisteners.ErrOwnershipControlUnavailable
		}
		if err != nil {
			return handofflisteners.OwnershipProof{}, fmt.Errorf("inspect absent %s control endpoint: %w", role, err)
		}
		defer socket.Close()
		if err := socket.proveRefused(client.timeout()); err != nil {
			return handofflisteners.OwnershipProof{}, fmt.Errorf("prove absent %s control endpoint: %w", role, err)
		}
		return handofflisteners.OwnershipProof{}, handofflisteners.ErrOwnershipControlUnavailable
	}
	if err != nil {
		return handofflisteners.OwnershipProof{}, fmt.Errorf("open %s ownership control socket: %w", role, err)
	}
	defer socket.Close()
	token, err := driver.ReadOwnerSecret(endpoint.TokenFile)
	if err != nil {
		return handofflisteners.OwnershipProof{}, fmt.Errorf("read %s ownership control token: %w", role, err)
	}
	payload, err := handofflisteners.EncodeOwnershipChallenge(challenge)
	if err != nil {
		return handofflisteners.OwnershipProof{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://manager"+handofflisteners.OwnershipControlPath, bytes.NewReader(payload))
	if err != nil {
		return handofflisteners.OwnershipProof{}, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	transport := &http.Transport{DialContext: func(dialContext context.Context, _, _ string) (net.Conn, error) {
		return socket.dial(dialContext, endpoint.PID, client.timeout())
	}}
	defer transport.CloseIdleConnections()
	httpClient := &http.Client{
		Transport: transport,
		Timeout:   client.timeout(),
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("ownership control redirects are forbidden")
		},
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return handofflisteners.OwnershipProof{}, fmt.Errorf("request %s ownership proof: %w", role, err)
	}
	defer response.Body.Close()
	data, readErr := io.ReadAll(io.LimitReader(response.Body, handofflisteners.MaximumOwnershipPayloadBytes+1))
	if readErr != nil {
		return handofflisteners.OwnershipProof{}, fmt.Errorf("read %s ownership proof: %w", role, readErr)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return handofflisteners.OwnershipProof{}, fmt.Errorf("%s ownership control HTTP %d: %s", role, response.StatusCode, boundedBody(data))
	}
	if len(data) > handofflisteners.MaximumOwnershipPayloadBytes {
		return handofflisteners.OwnershipProof{}, errors.New("ownership proof exceeds the closed-world response limit")
	}
	proof, err := handofflisteners.DecodeOwnershipProof(challenge, data)
	if err != nil {
		return handofflisteners.OwnershipProof{}, fmt.Errorf("decode %s ownership proof: %w", role, err)
	}
	return proof, nil
}

func (client Client) timeout() time.Duration {
	if client.Timeout <= 0 {
		return 2 * time.Second
	}
	return client.Timeout
}

func validateEndpoint(journal handoff.Journal, role handofflisteners.PublicOwner, endpoint Endpoint) error {
	wanted := ""
	switch role {
	case handofflisteners.OwnerSource:
		wanted = journal.Source.SocketPath
	case handofflisteners.OwnerTarget:
		wanted = journal.Target.SocketPath
	default:
		return errors.New("ownership control role is invalid")
	}
	for name, path := range map[string]string{"socket": endpoint.SocketPath, "token": endpoint.TokenFile} {
		if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path || strings.ContainsRune(path, 0) {
			return fmt.Errorf("ownership control %s path is not canonical and absolute", name)
		}
	}
	if wanted == "" || endpoint.SocketPath != wanted {
		return errors.New("ownership control socket does not equal its absolute journal binding")
	}
	if endpoint.ProcessAbsent {
		if endpoint.PID != 0 {
			return errors.New("absent ownership control process unexpectedly has a PID")
		}
	} else if endpoint.PID <= 0 {
		return errors.New("live ownership control endpoint requires a proven PID")
	}
	return nil
}

type securedSocket struct {
	directory     *os.File
	directoryPath string
	path          string
	address       string
	identity      socketIdentity
	directoryID   syscall.Stat_t
}

type socketIdentity struct {
	device uint64
	inode  uint64
	uid    uint32
	mode   os.FileMode
}

func openSocket(path string) (*securedSocket, error) {
	directoryPath := filepath.Dir(path)
	fd, err := openDirectoryNoSymlinks(directoryPath)
	if err != nil {
		return nil, err
	}
	directory := os.NewFile(uintptr(fd), directoryPath)
	if directory == nil {
		_ = syscall.Close(fd)
		return nil, errors.New("open ownership control directory returned an invalid descriptor")
	}
	keep := false
	defer func() {
		if !keep {
			_ = directory.Close()
		}
	}()
	var directoryID syscall.Stat_t
	if err := syscall.Fstat(fd, &directoryID); err != nil || directoryID.Uid != uint32(os.Getuid()) || directoryID.Mode&syscall.S_IFMT != syscall.S_IFDIR || directoryID.Mode&0o077 != 0 {
		return nil, errors.New("ownership control directory is not owner-only")
	}
	address := "/proc/self/fd/" + strconv.Itoa(fd) + "/" + filepath.Base(path)
	identity, err := inspectSocket(address)
	if err != nil {
		return nil, err
	}
	secured := &securedSocket{directory: directory, directoryPath: directoryPath, path: path, address: address, identity: identity, directoryID: directoryID}
	if err := secured.validate(); err != nil {
		return nil, err
	}
	keep = true
	return secured, nil
}

func inspectSocket(path string) (socketIdentity, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return socketIdentity{}, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || info.Mode()&os.ModeType != os.ModeSocket || info.Mode()&os.ModeSymlink != 0 || stat.Uid != uint32(os.Getuid()) || info.Mode().Perm() != 0o600 {
		return socketIdentity{}, errors.New("ownership control path is not an owner-only Unix socket")
	}
	return socketIdentity{device: uint64(stat.Dev), inode: uint64(stat.Ino), uid: stat.Uid, mode: info.Mode()}, nil
}

func (socket *securedSocket) validate() error {
	if socket == nil || socket.directory == nil {
		return errors.New("ownership control socket is closed")
	}
	var opened syscall.Stat_t
	if err := syscall.Fstat(int(socket.directory.Fd()), &opened); err != nil || opened.Dev != socket.directoryID.Dev || opened.Ino != socket.directoryID.Ino || opened.Uid != socket.directoryID.Uid {
		return errors.New("ownership control directory descriptor changed")
	}
	pathInfo, err := os.Lstat(socket.directoryPath)
	pathStat, ok := pathInfoSys(pathInfo)
	if err != nil || !ok || pathStat.Dev != opened.Dev || pathStat.Ino != opened.Ino || pathStat.Uid != opened.Uid {
		return errors.New("ownership control directory path changed")
	}
	identity, err := inspectSocket(socket.address)
	if err != nil || identity != socket.identity {
		return errors.New("ownership control socket path identity changed")
	}
	return nil
}

func pathInfoSys(info os.FileInfo) (*syscall.Stat_t, bool) {
	if info == nil {
		return nil, false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return stat, ok
}

func (socket *securedSocket) dial(ctx context.Context, expectedPID int, timeout time.Duration) (net.Conn, error) {
	if err := socket.validate(); err != nil {
		return nil, err
	}
	connection, err := (&net.Dialer{Timeout: timeout}).DialContext(ctx, "unix", socket.address)
	if err != nil {
		return nil, err
	}
	unix, ok := connection.(*net.UnixConn)
	if !ok {
		_ = connection.Close()
		return nil, errors.New("ownership control connection is not Unix")
	}
	credential, err := peerCredential(unix)
	if err != nil || credential.Uid != uint32(os.Getuid()) || int(credential.Pid) != expectedPID {
		_ = connection.Close()
		return nil, errors.New("ownership control peer process does not match the proven participant")
	}
	if err := socket.validate(); err != nil {
		_ = connection.Close()
		return nil, err
	}
	return connection, nil
}

func (socket *securedSocket) proveRefused(timeout time.Duration) error {
	if err := socket.validate(); err != nil {
		return err
	}
	connection, err := net.DialTimeout("unix", socket.address, timeout)
	if err == nil {
		_ = connection.Close()
		return errors.New("journal-bound ownership control endpoint is still live")
	}
	if !errors.Is(err, syscall.ECONNREFUSED) {
		return fmt.Errorf("ownership control absence is ambiguous: %w", err)
	}
	return socket.validate()
}

func peerCredential(connection *net.UnixConn) (*syscall.Ucred, error) {
	raw, err := connection.SyscallConn()
	if err != nil {
		return nil, err
	}
	var credential *syscall.Ucred
	var controlErr error
	if err := raw.Control(func(fd uintptr) {
		credential, controlErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil {
		return nil, err
	}
	if controlErr != nil || credential == nil {
		return nil, errors.New("ownership control peer credentials are unavailable")
	}
	return credential, nil
}

func openDirectoryNoSymlinks(path string) (int, error) {
	if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return -1, errors.New("ownership control directory path is invalid")
	}
	fd, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	for _, component := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
		if component == "" || component == "." || component == ".." {
			_ = syscall.Close(fd)
			return -1, errors.New("ownership control directory path is not canonical")
		}
		next, openErr := syscall.Openat(fd, component, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
		_ = syscall.Close(fd)
		if openErr != nil {
			return -1, openErr
		}
		fd = next
	}
	return fd, nil
}

func (socket *securedSocket) Close() error {
	if socket == nil || socket.directory == nil {
		return nil
	}
	err := socket.directory.Close()
	socket.directory = nil
	return err
}

func boundedBody(data []byte) string {
	value := strings.TrimSpace(string(data))
	if len(value) > 512 {
		value = value[:512]
	}
	if value == "" {
		return "empty response"
	}
	return value
}
