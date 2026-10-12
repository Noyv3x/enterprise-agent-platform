package executor

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/driver"
)

// The sandbox service proxy lets Platform reach a named background service that
// declared a port. The destination is never caller-supplied: only the owner's
// own running process, the sandbox container's core-network IP resolved by the
// driver, and the port recorded at start are ever dialled.

const (
	proxyBodyLimit       = 32 << 20
	proxyDialTimeout     = 10 * time.Second
	proxyIdleTimeout     = 120 * time.Second
	proxyWebSocketLife   = time.Hour
	proxyWebSocketIdle   = 10 * time.Minute
	proxyOwnerStreams    = 32
	proxyAddressLifetime = 30 * time.Second
	proxyHeaderLimit     = 64 << 10
)

// ProxyLimits are the proxy tunables; zero values mean the documented defaults
// (tests shorten them).
type ProxyLimits struct {
	BodyLimit    int64
	DialTimeout  time.Duration
	IdleTimeout  time.Duration
	SocketLife   time.Duration
	SocketIdle   time.Duration
	OwnerStreams int
}

func (l ProxyLimits) withDefaults() ProxyLimits {
	if l.BodyLimit <= 0 {
		l.BodyLimit = proxyBodyLimit
	}
	if l.DialTimeout <= 0 {
		l.DialTimeout = proxyDialTimeout
	}
	if l.IdleTimeout <= 0 {
		l.IdleTimeout = proxyIdleTimeout
	}
	if l.SocketLife <= 0 {
		l.SocketLife = proxyWebSocketLife
	}
	if l.SocketIdle <= 0 {
		l.SocketIdle = proxyWebSocketIdle
	}
	if l.OwnerStreams <= 0 {
		l.OwnerStreams = proxyOwnerStreams
	}
	return l
}

type proxyAddress struct {
	ip      string
	expires time.Time
}

type proxyState struct {
	mu        sync.Mutex
	streams   map[string]int
	addresses map[string]proxyAddress
}

// Request headers never forwarded: credentials, forwarding metadata, routing
// metadata and the hop-by-hop set (RFC 9110 §7.6.1 plus common legacy names).
var proxyDroppedRequestHeaders = map[string]bool{
	"Cookie": true, "Authorization": true, "Proxy-Authorization": true, "Forwarded": true,
	"X-Real-Ip": true, "X-Owner": true, "Via": true,
	"Connection": true, "Keep-Alive": true, "Proxy-Connection": true, "Te": true, "Trailer": true,
	"Transfer-Encoding": true, "Upgrade": true, "Proxy-Authenticate": true,
}

var proxyDroppedResponseHeaders = map[string]bool{
	"Connection": true, "Keep-Alive": true, "Proxy-Connection": true, "Te": true, "Trailer": true,
	"Transfer-Encoding": true, "Upgrade": true, "Proxy-Authenticate": true,
}

type proxyTarget struct {
	port      int
	sandboxID string
	done      <-chan struct{}
}

// proxyTarget authorizes the call: the owner's own, running process that
// declared a port. Anything else is indistinguishable ErrProcessNotFound.
func (m *BackgroundManager) proxyTarget(id, owner string) (proxyTarget, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, err := m.lookupLocked(id, owner)
	if err != nil {
		return proxyTarget{}, err
	}
	if p.rec.State != "running" || p.rec.Port == nil || p.rec.Name == nil {
		return proxyTarget{}, ErrProcessNotFound
	}
	return proxyTarget{port: *p.rec.Port, sandboxID: p.rec.Identity.ExecutionContext.SandboxID, done: p.done}, nil
}

func (m *BackgroundManager) acquireStream(owner string, limit int) bool {
	m.proxy.mu.Lock()
	defer m.proxy.mu.Unlock()
	if m.proxy.streams == nil {
		m.proxy.streams = map[string]int{}
	}
	if m.proxy.streams[owner] >= limit {
		return false
	}
	m.proxy.streams[owner]++
	return true
}

func (m *BackgroundManager) releaseStream(owner string) {
	m.proxy.mu.Lock()
	defer m.proxy.mu.Unlock()
	if m.proxy.streams[owner] <= 1 {
		delete(m.proxy.streams, owner)
		return
	}
	m.proxy.streams[owner]--
}

// proxyIP resolves (and briefly caches) the sandbox container address. A
// running process pins its sandbox (residency), so the address cannot change
// under it; the short lifetime and the drop on a failed dial bound any drift.
func (m *BackgroundManager) proxyIP(ctx context.Context, id string, target proxyTarget) (string, error) {
	now := time.Now()
	m.proxy.mu.Lock()
	cached, ok := m.proxy.addresses[id]
	m.proxy.mu.Unlock()
	if ok && now.Before(cached.expires) {
		return cached.ip, nil
	}
	resolver, ok := m.Engine.(driver.SandboxEndpointResolver)
	if !ok {
		return "", errors.New("sandbox endpoint resolution is unavailable")
	}
	spec, err := m.Sandboxes.Spec(target.sandboxID)
	if err != nil {
		return "", err
	}
	ip, err := resolver.ResolveSandboxIP(ctx, spec.ContainerName, spec.AgentHash, spec.Network)
	if err != nil {
		return "", err
	}
	m.proxy.mu.Lock()
	if m.proxy.addresses == nil {
		m.proxy.addresses = map[string]proxyAddress{}
	}
	m.proxy.addresses[id] = proxyAddress{ip: ip, expires: now.Add(proxyAddressLifetime)}
	m.proxy.mu.Unlock()
	return ip, nil
}

func (m *BackgroundManager) forgetProxyIP(id string) {
	m.proxy.mu.Lock()
	delete(m.proxy.addresses, id)
	m.proxy.mu.Unlock()
}

func (m *BackgroundManager) proxyDial(ctx context.Context, id string, target proxyTarget, limits ProxyLimits) (net.Conn, error) {
	ip, err := m.proxyIP(ctx, id, target)
	if err != nil {
		return nil, err
	}
	dialer := net.Dialer{Timeout: limits.DialTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(ip, strconv.Itoa(target.port)))
	if err != nil {
		m.forgetProxyIP(id)
		return nil, err
	}
	return conn, nil
}

func proxyConnectionTokens(header http.Header) map[string]bool {
	tokens := map[string]bool{}
	for _, value := range header.Values("Connection") {
		for _, token := range strings.Split(value, ",") {
			if token = strings.TrimSpace(token); token != "" {
				tokens[http.CanonicalHeaderKey(token)] = true
			}
		}
	}
	return tokens
}

func isWebSocketUpgrade(request *http.Request) bool {
	if request.Method != http.MethodGet {
		return false
	}
	upgrade := false
	for _, token := range strings.Split(strings.Join(request.Header.Values("Connection"), ","), ",") {
		if strings.EqualFold(strings.TrimSpace(token), "upgrade") {
			upgrade = true
		}
	}
	return upgrade && strings.EqualFold(strings.TrimSpace(request.Header.Get("Upgrade")), "websocket")
}

func proxyOutHeader(in http.Header, webSocket bool) http.Header {
	out := make(http.Header, len(in))
	named := proxyConnectionTokens(in)
	for key, values := range in {
		canonical := http.CanonicalHeaderKey(key)
		if proxyDroppedRequestHeaders[canonical] || named[canonical] || strings.HasPrefix(canonical, "X-Forwarded-") {
			if !(webSocket && strings.HasPrefix(canonical, "Sec-Websocket-")) {
				continue
			}
		}
		out[canonical] = append([]string(nil), values...)
	}
	if webSocket {
		out.Set("Connection", "Upgrade")
		out.Set("Upgrade", "websocket")
	}
	return out
}

func writeProxyError(response http.ResponseWriter, status int, message string) {
	response.Header().Set("Content-Type", "application/json")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(map[string]string{"error": message})
}

// ServeProxy answers one request for the process in a raw, streaming fashion.
// path is the escaped path below the process id (leading slash included).
func (s *Service) ServeProxy(response http.ResponseWriter, request *http.Request, processID, path string) {
	if s.Background == nil {
		writeProxyError(response, http.StatusNotFound, ErrProcessNotFound.Error())
		return
	}
	s.Background.serveProxy(response, request, processID, path)
}

func (m *BackgroundManager) serveProxy(response http.ResponseWriter, request *http.Request, id, path string) {
	limits := m.Proxy.withDefaults()
	owner := request.Header.Get("X-Owner")
	target, err := m.proxyTarget(id, owner)
	if err != nil {
		writeProxyError(response, http.StatusNotFound, ErrProcessNotFound.Error())
		return
	}
	if request.ContentLength > limits.BodyLimit {
		writeProxyError(response, http.StatusRequestEntityTooLarge, "request body is too large")
		return
	}
	if !m.acquireStream(owner, limits.OwnerStreams) {
		writeProxyError(response, http.StatusTooManyRequests, "too many concurrent proxied streams")
		return
	}
	defer m.releaseStream(owner)

	ctx, cancel := context.WithCancel(request.Context())
	defer cancel()
	go func() {
		select {
		case <-target.done:
			cancel()
		case <-ctx.Done():
		}
	}()

	if isWebSocketUpgrade(request) {
		m.serveWebSocket(ctx, response, request, id, target, path, limits)
		return
	}
	m.serveHTTP(ctx, cancel, response, request, id, target, path, limits)
}

func proxyURL(port int, path string, request *http.Request) (string, string) {
	if path == "" || path[0] != '/' {
		path = "/" + path
	}
	host := "localhost:" + strconv.Itoa(port)
	url := "http://" + host + path
	if request.URL.RawQuery != "" {
		url += "?" + request.URL.RawQuery
	}
	return url, host
}

// activityTimer cancels the stream when nothing moved for the idle period.
type activityTimer struct {
	timer   *time.Timer
	idle    time.Duration
	expired atomic.Bool
}

func newActivityTimer(idle time.Duration, onExpire func()) *activityTimer {
	a := &activityTimer{idle: idle}
	a.timer = time.AfterFunc(idle, func() {
		a.expired.Store(true)
		onExpire()
	})
	return a
}
func (a *activityTimer) touch() { a.timer.Reset(a.idle) }
func (a *activityTimer) stop()  { a.timer.Stop() }

type touchReader struct {
	reader io.Reader
	timer  *activityTimer
}

func (t touchReader) Read(p []byte) (int, error) {
	n, err := t.reader.Read(p)
	if n > 0 {
		t.timer.touch()
	}
	return n, err
}

func (m *BackgroundManager) newTransport(ctx context.Context, id string, target proxyTarget, limits ProxyLimits) *http.Transport {
	return &http.Transport{
		// The URL host is a label only: every connection goes to the resolved
		// sandbox address and the registered port, never to a name.
		DialContext: func(dialCtx context.Context, _, _ string) (net.Conn, error) {
			return m.proxyDial(dialCtx, id, target, limits)
		},
		Proxy:                  nil,
		DisableKeepAlives:      true,
		DisableCompression:     true,
		ResponseHeaderTimeout:  limits.IdleTimeout,
		MaxResponseHeaderBytes: proxyHeaderLimit,
	}
}

func (m *BackgroundManager) serveHTTP(ctx context.Context, cancel context.CancelFunc, response http.ResponseWriter, request *http.Request, id string, target proxyTarget, path string, limits ProxyLimits) {
	url, host := proxyURL(target.port, path, request)
	timer := newActivityTimer(limits.IdleTimeout, cancel)
	defer timer.stop()
	var body io.Reader = http.NoBody
	if request.ContentLength != 0 {
		body = touchReader{reader: http.MaxBytesReader(response, request.Body, limits.BodyLimit), timer: timer}
	}
	outgoing, err := http.NewRequestWithContext(ctx, request.Method, url, body)
	if err != nil {
		writeProxyError(response, http.StatusBadRequest, "invalid proxied request")
		return
	}
	outgoing.Host = host
	outgoing.Header = proxyOutHeader(request.Header, false)
	if request.ContentLength != 0 {
		outgoing.ContentLength = request.ContentLength
	}
	controller := http.NewResponseController(response)
	_ = controller.EnableFullDuplex()
	transport := m.newTransport(ctx, id, target, limits)
	defer transport.CloseIdleConnections()
	upstream, err := transport.RoundTrip(outgoing)
	if err != nil {
		var tooLarge *http.MaxBytesError
		switch {
		case errors.As(err, &tooLarge):
			writeProxyError(response, http.StatusRequestEntityTooLarge, "request body is too large")
		case timer.expired.Load():
			writeProxyError(response, http.StatusGatewayTimeout, "service did not respond in time")
		case ctx.Err() != nil:
			writeProxyError(response, http.StatusBadGateway, "service stopped")
		default:
			writeProxyError(response, http.StatusBadGateway, "service is unreachable")
		}
		return
	}
	defer upstream.Body.Close()
	timer.touch()
	for key, values := range upstream.Header {
		if proxyDroppedResponseHeaders[http.CanonicalHeaderKey(key)] {
			continue
		}
		response.Header()[key] = values
	}
	for key := range proxyConnectionTokens(upstream.Header) {
		response.Header().Del(key)
	}
	response.WriteHeader(upstream.StatusCode)
	// Headers go out now: an event stream may not produce a first byte for a while.
	_ = controller.Flush()
	buffer := make([]byte, 32<<10)
	for {
		n, readErr := upstream.Body.Read(buffer)
		if n > 0 {
			timer.touch()
			if _, err := response.Write(buffer[:n]); err != nil {
				return
			}
			_ = controller.Flush()
		}
		if readErr != nil {
			if readErr != io.EOF {
				// A truncated stream must not look complete.
				panic(http.ErrAbortHandler)
			}
			return
		}
	}
}

func (m *BackgroundManager) serveWebSocket(ctx context.Context, response http.ResponseWriter, request *http.Request, id string, target proxyTarget, path string, limits ProxyLimits) {
	url, host := proxyURL(target.port, path, request)
	outgoing, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		writeProxyError(response, http.StatusBadRequest, "invalid proxied request")
		return
	}
	outgoing.Host = host
	outgoing.Header = proxyOutHeader(request.Header, true)
	upstreamConn, err := m.proxyDial(ctx, id, target, limits)
	if err != nil {
		writeProxyError(response, http.StatusBadGateway, "service is unreachable")
		return
	}
	defer upstreamConn.Close()
	_ = upstreamConn.SetDeadline(time.Now().Add(limits.IdleTimeout))
	if err := outgoing.Write(upstreamConn); err != nil {
		writeProxyError(response, http.StatusBadGateway, "service is unreachable")
		return
	}
	upstreamReader := bufio.NewReaderSize(upstreamConn, 32<<10)
	upstream, err := http.ReadResponse(upstreamReader, outgoing)
	if err != nil {
		writeProxyError(response, http.StatusBadGateway, "service is unreachable")
		return
	}
	_ = upstreamConn.SetDeadline(time.Time{})
	if upstream.StatusCode != http.StatusSwitchingProtocols {
		// The service declined the upgrade: relay its answer as a plain response.
		defer upstream.Body.Close()
		for key, values := range upstream.Header {
			if !proxyDroppedResponseHeaders[http.CanonicalHeaderKey(key)] {
				response.Header()[key] = values
			}
		}
		response.WriteHeader(upstream.StatusCode)
		_, _ = io.Copy(response, io.LimitReader(upstream.Body, 1<<20))
		return
	}
	controller := http.NewResponseController(response)
	clientConn, clientBuffer, err := controller.Hijack()
	if err != nil {
		writeProxyError(response, http.StatusInternalServerError, "websocket relay is unavailable")
		return
	}
	defer clientConn.Close()
	if err := upstream.Write(clientBuffer); err != nil {
		return
	}
	if err := clientBuffer.Flush(); err != nil {
		return
	}

	life := time.AfterFunc(limits.SocketLife, func() { _ = clientConn.Close(); _ = upstreamConn.Close() })
	defer life.Stop()
	closeBoth := func() { _ = clientConn.Close(); _ = upstreamConn.Close() }
	idle := newActivityTimer(limits.SocketIdle, closeBoth)
	defer idle.stop()
	go func() {
		<-ctx.Done()
		closeBoth()
	}()
	var wait sync.WaitGroup
	wait.Add(2)
	pump := func(dst io.Writer, src io.Reader) {
		defer wait.Done()
		_, _ = io.Copy(dst, touchReader{reader: src, timer: idle})
		closeBoth()
	}
	go pump(upstreamConn, clientBuffer.Reader)
	go pump(clientConn, upstreamReader)
	wait.Wait()
}
