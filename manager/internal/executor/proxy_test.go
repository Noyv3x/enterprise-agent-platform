package executor

import (
	"bufio"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// proxyEngine resolves every sandbox to loopback, where the test upstreams
// listen; it records what it was asked to resolve.
type proxyEngine struct {
	engineStub
	calls *atomic.Int64
	ip    string
}

func (e proxyEngine) ResolveSandboxIP(_ context.Context, name, hash, network string) (string, error) {
	e.calls.Add(1)
	if name == "" || hash == "" || network != "network" {
		return "", errors.New("unexpected sandbox identity")
	}
	return e.ip, nil
}

type proxyFixture struct {
	service *Service
	front   *httptest.Server
	calls   *atomic.Int64
}

// newProxyFixture serves the proxy the way the control API does: the first
// path segment is the process id, the rest is forwarded.
func newProxyFixture(t *testing.T, limits ProxyLimits) *proxyFixture {
	t.Helper()
	calls := &atomic.Int64{}
	service, _ := newTestServiceWithEngine(t, proxyEngine{calls: calls, ip: "127.0.0.1"})
	service.Background.Proxy = limits
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rest, _ := strings.CutPrefix(r.URL.EscapedPath(), "/v1/executor/proxy/")
		id, path, _ := strings.Cut(rest, "/")
		service.ServeProxy(w, r, id, "/"+path)
	}))
	t.Cleanup(front.Close)
	return &proxyFixture{service: service, front: front, calls: calls}
}

func upstreamPort(t *testing.T, server *httptest.Server) int {
	t.Helper()
	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, _ := strconv.Atoi(parsed.Port())
	return port
}

// start launches a named service declaring port and registers its cleanup.
func (f *proxyFixture) start(t *testing.T, ident Identity, name string, port *int) ProcessView {
	t.Helper()
	view := bgStart(t, f.service, ident, processStartArguments{Command: "sleep 60", Name: &name, Port: port})
	t.Cleanup(func() {
		if current, err := f.service.Background.List(ProcessListRequest{Owner: view.Owner}); err == nil {
			for _, v := range current {
				if v.ID == view.ID && v.State == "running" {
					_, _ = f.service.Background.Kill(view.ID, view.Owner)
				}
			}
		}
	})
	return view
}

func (f *proxyFixture) request(t *testing.T, method, id, path, owner string, body io.Reader, headers map[string]string) *http.Response {
	t.Helper()
	request, err := http.NewRequest(method, f.front.URL+"/v1/executor/proxy/"+id+path, body)
	if err != nil {
		t.Fatal(err)
	}
	if owner != "" {
		request.Header.Set("X-Owner", owner)
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }, Timeout: 20 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { response.Body.Close() })
	return response
}

func readBody(t *testing.T, response *http.Response) string {
	t.Helper()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func intPtr(v int) *int { return &v }

func foreignIdentity() Identity {
	foreign := identity()
	foreign.ScopeID = "private:2"
	foreign.ExecutionContext = ExecutionContext{SandboxID: "private-2", WorkspaceID: "user-2"}
	return foreign
}

func TestServicePortIsPersistedAndShownInProcessView(t *testing.T) {
	service, root := newTestService(t)
	name := "web"
	view := bgStart(t, service, identity(), processStartArguments{Command: "sleep 60", Name: &name, Port: intPtr(5173)})
	t.Cleanup(func() { _, _ = service.Background.Kill(view.ID, "private:1") })
	if view.Port == nil || *view.Port != 5173 {
		t.Fatalf("start view lost the port: %+v", view)
	}
	encoded, _ := json.Marshal(view)
	if !strings.Contains(string(encoded), `"port":5173`) {
		t.Fatalf("view JSON: %s", encoded)
	}
	listed, err := service.Background.List(ProcessListRequest{Owner: "private:1"})
	if err != nil || len(listed) != 1 || listed[0].Port == nil || *listed[0].Port != 5173 {
		t.Fatalf("list: %+v %v", listed, err)
	}
	plain := bgStart(t, service, identity(), processStartArguments{Command: "sleep 60"})
	t.Cleanup(func() { _, _ = service.Background.Kill(plain.ID, "private:1") })
	encoded, _ = json.Marshal(plain)
	if plain.Port != nil || !strings.Contains(string(encoded), `"port":null`) {
		t.Fatalf("portless view: %s", encoded)
	}
	// The record survives a Manager restart with its port.
	restarted, err := NewBackgroundManager(testActiveProfile, engineStub{}, service.Background.Sandboxes, service.Audits, BackgroundConfig{Dir: root + "/manager/processes"})
	if err != nil {
		t.Fatal(err)
	}
	reloaded, err := restarted.List(ProcessListRequest{Owner: "private:1"})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, v := range reloaded {
		if v.ID == view.ID {
			found = v.Port != nil && *v.Port == 5173
		}
	}
	if !found {
		t.Fatalf("reloaded records lost the port: %+v", reloaded)
	}
	for _, bad := range []processStartArguments{
		{Command: "true", Name: &name, Port: intPtr(0)},
		{Command: "true", Name: &name, Port: intPtr(65536)},
		{Command: "true", Name: &name, Port: intPtr(-1)},
		{Command: "true", Port: intPtr(8080)}, // a port needs a named service
	} {
		if _, err := bgStartErr(service, t, identity(), bad); err == nil {
			t.Fatalf("invalid start accepted: %+v", bad)
		}
	}
}

func TestProxyServesOnlyTheOwnersRunningProcessWithAPort(t *testing.T) {
	f := newProxyFixture(t, ProxyLimits{})
	var hits atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		io.WriteString(w, "hello "+r.URL.Path)
	}))
	defer upstream.Close()
	port := upstreamPort(t, upstream)
	view := f.start(t, identity(), "web", &port)
	portless := f.start(t, identity(), "noport", nil)

	ok := f.request(t, "GET", view.ID, "/a/b", "private:1", nil, nil)
	if ok.StatusCode != 200 || readBody(t, ok) != "hello /a/b" {
		t.Fatalf("owner request failed: %d", ok.StatusCode)
	}
	if f.calls.Load() == 0 {
		t.Fatal("the sandbox address was never resolved through the driver")
	}
	before := hits.Load()
	for name, response := range map[string]*http.Response{
		"foreign owner":   f.request(t, "GET", view.ID, "/", "private:2", nil, nil),
		"missing owner":   f.request(t, "GET", view.ID, "/", "", nil, nil),
		"unknown process": f.request(t, "GET", "proc_00000000000000000000000000", "/", "private:1", nil, nil),
		"malformed id":    f.request(t, "GET", "x", "/", "private:1", nil, nil),
		"no port":         f.request(t, "GET", portless.ID, "/", "private:1", nil, nil),
	} {
		if response.StatusCode != 404 {
			t.Fatalf("%s: status %d, want 404", name, response.StatusCode)
		}
	}
	if hits.Load() != before {
		t.Fatal("a rejected request reached the upstream")
	}
	// The same process owned by another owner is just as invisible.
	foreignPort := port
	other := f.start(t, foreignIdentity(), "web", &foreignPort)
	if response := f.request(t, "GET", other.ID, "/", "private:1", nil, nil); response.StatusCode != 404 {
		t.Fatalf("cross-owner id: %d", response.StatusCode)
	}
	if response := f.request(t, "GET", other.ID, "/", "private:2", nil, nil); response.StatusCode != 200 {
		t.Fatalf("second owner's own service: %d", response.StatusCode)
	}
	// An ended process is no longer proxied.
	bgKill(t, f.service, identity(), view.ID)
	if response := f.request(t, "GET", view.ID, "/", "private:1", nil, nil); response.StatusCode != 404 {
		t.Fatalf("ended process: %d", response.StatusCode)
	}
}

func TestProxyStripsCredentialsAndForwardingHeadersAndSetsHost(t *testing.T) {
	f := newProxyFixture(t, ProxyLimits{})
	var seen http.Header
	var seenHost, seenURI, seenMethod string
	var seenBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen, seenHost, seenURI, seenMethod = r.Header.Clone(), r.Host, r.RequestURI, r.Method
		data, _ := io.ReadAll(r.Body)
		seenBody = string(data)
		w.Header().Set("X-Upstream", "yes")
		w.Header().Set("Set-Cookie", "a=b")
		w.WriteHeader(201)
	}))
	defer upstream.Close()
	port := upstreamPort(t, upstream)
	view := f.start(t, identity(), "web", &port)
	response := f.request(t, "POST", view.ID+"", "/p/q%2Fr?x=1&y=%20z", "private:1", strings.NewReader("payload"), map[string]string{
		"Authorization": "Bearer manager-secret", "Proxy-Authorization": "Basic x", "Cookie": "session=1",
		"X-Forwarded-For": "1.2.3.4", "X-Forwarded-Host": "evil", "Forwarded": "for=1.2.3.4", "X-Real-Ip": "1.2.3.4",
		"Connection": "X-Secret", "X-Secret": "hop", "Keep-Alive": "5", "Te": "trailers", "Via": "1.1 x",
		"X-App": "kept", "Content-Type": "text/plain", "Accept-Encoding": "gzip",
	})
	if response.StatusCode != 201 || response.Header.Get("X-Upstream") != "yes" {
		t.Fatalf("status %d headers %v", response.StatusCode, response.Header)
	}
	for _, name := range []string{"Authorization", "Proxy-Authorization", "Cookie", "X-Forwarded-For", "X-Forwarded-Host", "Forwarded", "X-Real-Ip", "X-Secret", "Keep-Alive", "Te", "Via", "X-Owner"} {
		if seen.Get(name) != "" {
			t.Fatalf("%s reached the upstream: %v", name, seen)
		}
	}
	if seen.Get("X-App") != "kept" || seen.Get("Content-Type") != "text/plain" || seen.Get("Accept-Encoding") != "gzip" {
		t.Fatalf("ordinary headers were not forwarded: %v", seen)
	}
	if seenHost != "localhost:"+strconv.Itoa(port) {
		t.Fatalf("Host = %q", seenHost)
	}
	if seenMethod != "POST" || seenURI != "/p/q%2Fr?x=1&y=%20z" || seenBody != "payload" {
		t.Fatalf("request line/body: %s %s %q", seenMethod, seenURI, seenBody)
	}
}

func TestProxyNeverFollowsRedirects(t *testing.T) {
	f := newProxyFixture(t, ProxyLimits{})
	var followed atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/elsewhere" {
			followed.Add(1)
		}
		w.Header().Set("Location", "/elsewhere")
		w.WriteHeader(http.StatusFound)
	}))
	defer upstream.Close()
	port := upstreamPort(t, upstream)
	view := f.start(t, identity(), "web", &port)
	response := f.request(t, "GET", view.ID, "/start", "private:1", nil, nil)
	if response.StatusCode != http.StatusFound || response.Header.Get("Location") != "/elsewhere" {
		t.Fatalf("redirect was not passed through: %d %v", response.StatusCode, response.Header)
	}
	time.Sleep(100 * time.Millisecond)
	if followed.Load() != 0 {
		t.Fatal("the proxy followed an upstream redirect")
	}
}

func TestProxyStreamsRequestAndResponseBodies(t *testing.T) {
	f := newProxyFixture(t, ProxyLimits{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		controller := http.NewResponseController(w)
		_ = controller.EnableFullDuplex()
		w.WriteHeader(200)
		_ = controller.Flush()
		buffer := make([]byte, 16)
		for {
			n, err := r.Body.Read(buffer)
			if n > 0 {
				w.Write([]byte("echo:" + string(buffer[:n])))
				_ = controller.Flush()
			}
			if err != nil {
				return
			}
		}
	}))
	defer upstream.Close()
	port := upstreamPort(t, upstream)
	view := f.start(t, identity(), "web", &port)
	reader, writer := io.Pipe()
	response := f.request(t, "POST", view.ID, "/", "private:1", reader, nil)
	if response.StatusCode != 200 {
		t.Fatalf("status %d", response.StatusCode)
	}
	buffered := bufio.NewReader(response.Body)
	// Each chunk comes back before the next one is sent: nothing is buffered.
	for _, chunk := range []string{"one", "two", "three"} {
		if _, err := writer.Write([]byte(chunk)); err != nil {
			t.Fatal(err)
		}
		want := "echo:" + chunk
		got := make([]byte, len(want))
		done := make(chan error, 1)
		go func() { _, err := io.ReadFull(buffered, got); done <- err }()
		select {
		case err := <-done:
			if err != nil || string(got) != want {
				t.Fatalf("chunk %q: %q %v", chunk, got, err)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("chunk %q was held back (request or response is buffered)", chunk)
		}
	}
	writer.Close()
	if rest, _ := io.ReadAll(buffered); len(rest) != 0 {
		t.Fatalf("trailing bytes: %q", rest)
	}
}

func TestProxyCapsRequestBodies(t *testing.T) {
	f := newProxyFixture(t, ProxyLimits{BodyLimit: 1024})
	var received atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, _ := io.Copy(io.Discard, r.Body)
		received.Add(n)
		w.WriteHeader(200)
	}))
	defer upstream.Close()
	port := upstreamPort(t, upstream)
	view := f.start(t, identity(), "web", &port)

	if response := f.request(t, "POST", view.ID, "/", "private:1", strings.NewReader(strings.Repeat("a", 1024)), nil); response.StatusCode != 200 {
		t.Fatalf("a body at the cap: %d", response.StatusCode)
	}
	before := received.Load()
	over := strings.NewReader(strings.Repeat("a", 1025))
	if response := f.request(t, "POST", view.ID, "/", "private:1", over, nil); response.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("declared oversize body: %d", response.StatusCode)
	}
	if received.Load() != before {
		t.Fatal("an oversize declared body reached the upstream")
	}
	// An undeclared length (chunked) is counted as it streams.
	chunked := io.MultiReader(strings.NewReader(strings.Repeat("a", 700)), strings.NewReader(strings.Repeat("a", 700)))
	request, _ := http.NewRequest("POST", f.front.URL+"/v1/executor/proxy/"+view.ID+"/", struct{ io.Reader }{chunked})
	request.Header.Set("X-Owner", "private:1")
	response, err := http.DefaultClient.Do(request)
	if err == nil {
		defer response.Body.Close()
		if response.StatusCode != http.StatusRequestEntityTooLarge {
			t.Fatalf("an undeclared oversize body was accepted: %d", response.StatusCode)
		}
	}
}

func TestProxyIdleTimeoutCutsStalledResponsesAndSilentUpstreams(t *testing.T) {
	f := newProxyFixture(t, ProxyLimits{IdleTimeout: 300 * time.Millisecond})
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/silent" {
			<-release
			return
		}
		w.WriteHeader(200)
		io.WriteString(w, "first")
		http.NewResponseController(w).Flush()
		<-release
	}))
	defer upstream.Close()
	defer close(release) // runs first, so blocked handlers let Close finish
	port := upstreamPort(t, upstream)
	view := f.start(t, identity(), "web", &port)

	started := time.Now()
	if response := f.request(t, "GET", view.ID, "/silent", "private:1", nil, nil); response.StatusCode != http.StatusGatewayTimeout {
		t.Fatalf("an upstream that never answers: %d", response.StatusCode)
	}
	response := f.request(t, "GET", view.ID, "/stall", "private:1", nil, nil)
	buffer := make([]byte, 5)
	if _, err := io.ReadFull(response.Body, buffer); err != nil || string(buffer) != "first" {
		t.Fatalf("first chunk: %q %v", buffer, err)
	}
	if _, err := io.ReadAll(response.Body); err == nil {
		t.Fatal("a stalled response ended as if it were complete")
	}
	if time.Since(started) > 8*time.Second {
		t.Fatalf("idle timeout took %v", time.Since(started))
	}
}

// websocketUpstream accepts upgrades, records the handshake headers and echoes
// raw bytes (frame content is irrelevant to a byte tunnel).
type websocketUpstream struct {
	server  *httptest.Server
	mu      sync.Mutex
	headers http.Header
	host    string
	open    atomic.Int64
}

func newWebSocketUpstream(t *testing.T) *websocketUpstream {
	t.Helper()
	u := &websocketUpstream{}
	u.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u.mu.Lock()
		u.headers, u.host = r.Header.Clone(), r.Host
		u.mu.Unlock()
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			w.WriteHeader(http.StatusTeapot)
			return
		}
		sum := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
		conn, buffered, err := http.NewResponseController(w).Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		u.open.Add(1)
		defer u.open.Add(-1)
		buffered.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + base64.StdEncoding.EncodeToString(sum[:]) + "\r\n\r\n")
		buffered.Flush()
		_, _ = io.Copy(conn, buffered)
	}))
	t.Cleanup(u.server.Close)
	return u
}

func (u *websocketUpstream) seen() (http.Header, string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.headers, u.host
}

// dialUpgrade performs the client handshake against the proxy front and
// returns the open connection plus its reader.
func (f *proxyFixture) dialUpgrade(t *testing.T, id, path, owner string) (net.Conn, *bufio.Reader, *http.Response) {
	t.Helper()
	conn, err := net.Dial("tcp", strings.TrimPrefix(f.front.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	request := "GET /v1/executor/proxy/" + id + path + " HTTP/1.1\r\nHost: platform\r\nConnection: keep-alive, Upgrade\r\nUpgrade: websocket\r\n" +
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: vite-hmr\r\n" +
		"Cookie: session=1\r\nAuthorization: Bearer secret\r\nX-Owner: " + owner + "\r\n\r\n"
	if _, err := io.WriteString(conn, request); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	return conn, reader, response
}

func TestProxyRelaysWebSocketUpgrades(t *testing.T) {
	f := newProxyFixture(t, ProxyLimits{})
	upstream := newWebSocketUpstream(t)
	port := upstreamPort(t, upstream.server)
	view := f.start(t, identity(), "web", &port)

	conn, reader, response := f.dialUpgrade(t, view.ID, "/hmr?token=1", "private:1")
	if response.StatusCode != http.StatusSwitchingProtocols || response.Header.Get("Sec-WebSocket-Accept") != "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" {
		t.Fatalf("handshake: %d %v", response.StatusCode, response.Header)
	}
	headers, host := upstream.seen()
	if headers.Get("Cookie") != "" || headers.Get("Authorization") != "" || headers.Get("X-Owner") != "" {
		t.Fatalf("credentials crossed the upgrade: %v", headers)
	}
	if headers.Get("Sec-WebSocket-Key") == "" || headers.Get("Sec-WebSocket-Protocol") != "vite-hmr" || !strings.EqualFold(headers.Get("Upgrade"), "websocket") {
		t.Fatalf("handshake headers were not relayed: %v", headers)
	}
	if host != "localhost:"+strconv.Itoa(port) {
		t.Fatalf("Host = %q", host)
	}
	for _, message := range []string{"ping-1", "ping-2"} {
		io.WriteString(conn, message)
		got := make([]byte, len(message))
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		if _, err := io.ReadFull(reader, got); err != nil || string(got) != message {
			t.Fatalf("echo %q: %q %v", message, got, err)
		}
	}
	// Foreign owners cannot open the tunnel.
	_, _, denied := f.dialUpgrade(t, view.ID, "/hmr", "private:2")
	if denied.StatusCode != 404 {
		t.Fatalf("foreign upgrade: %d", denied.StatusCode)
	}
}

func TestProxyEndsRequestsAndWebSocketsWhenTheProcessEnds(t *testing.T) {
	f := newProxyFixture(t, ProxyLimits{})
	upstream := newWebSocketUpstream(t)
	port := upstreamPort(t, upstream.server)
	view := f.start(t, identity(), "web", &port)
	// A second HTTP service on its own port: a response that never ends.
	hang := make(chan struct{})
	sse := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		io.WriteString(w, "open")
		http.NewResponseController(w).Flush()
		<-hang
	}))
	defer sse.Close()
	defer close(hang)
	ssePort := upstreamPort(t, sse)
	events := f.start(t, identity(), "events", &ssePort)

	conn, reader, response := f.dialUpgrade(t, view.ID, "/", "private:1")
	if response.StatusCode != 101 {
		t.Fatalf("upgrade: %d", response.StatusCode)
	}
	stream := f.request(t, "GET", events.ID, "/", "private:1", nil, nil)
	first := make([]byte, 4)
	if _, err := io.ReadFull(stream.Body, first); err != nil {
		t.Fatal(err)
	}

	bgKill(t, f.service, identity(), view.ID)
	bgKill(t, f.service, identity(), events.ID)

	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := reader.ReadByte(); err == nil {
		t.Fatal("the websocket stayed open after the process ended")
	} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatal("the websocket was not closed when the process ended")
	}
	finished := make(chan error, 1)
	go func() { _, err := io.ReadAll(stream.Body); finished <- err }()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("the response stream outlived its process")
	}
	deadline := time.Now().Add(5 * time.Second)
	for upstream.open.Load() != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if upstream.open.Load() != 0 {
		t.Fatal("the upstream websocket connection was not closed")
	}
}

func TestProxyWebSocketIdleAndLifetimeLimits(t *testing.T) {
	for name, limits := range map[string]ProxyLimits{
		"idle":     {SocketIdle: 300 * time.Millisecond},
		"lifetime": {SocketLife: 300 * time.Millisecond},
	} {
		t.Run(name, func(t *testing.T) {
			f := newProxyFixture(t, limits)
			upstream := newWebSocketUpstream(t)
			port := upstreamPort(t, upstream.server)
			view := f.start(t, identity(), "web", &port)
			conn, reader, response := f.dialUpgrade(t, view.ID, "/", "private:1")
			if response.StatusCode != 101 {
				t.Fatalf("upgrade: %d", response.StatusCode)
			}
			if name == "lifetime" {
				// Traffic keeps it from idling, but the lifetime still ends it.
				stop := make(chan struct{})
				defer close(stop)
				go func() {
					for {
						select {
						case <-stop:
							return
						case <-time.After(50 * time.Millisecond):
							io.WriteString(conn, "x")
						}
					}
				}()
			}
			started := time.Now()
			_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
			var err error
			for err == nil {
				_, err = reader.ReadByte()
			}
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				t.Fatalf("%s limit did not close the tunnel", name)
			}
			if time.Since(started) > 4*time.Second {
				t.Fatalf("closed too late: %v", time.Since(started))
			}
		})
	}
}

func TestProxyLimitsConcurrentStreamsPerOwner(t *testing.T) {
	f := newProxyFixture(t, ProxyLimits{OwnerStreams: 2})
	release := make(chan struct{})
	var once sync.Once
	closeRelease := func() { once.Do(func() { close(release) }) }
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/hold" {
			w.WriteHeader(200)
			io.WriteString(w, "held")
			http.NewResponseController(w).Flush()
			<-release
			return
		}
		io.WriteString(w, "fast")
	}))
	defer upstream.Close()
	defer closeRelease()
	port := upstreamPort(t, upstream)
	view := f.start(t, identity(), "web", &port)
	other := f.start(t, foreignIdentity(), "web", &port)

	held := make([]*http.Response, 2)
	for i := range held {
		held[i] = f.request(t, "GET", view.ID, "/hold", "private:1", nil, nil)
		buffer := make([]byte, 4)
		if _, err := io.ReadFull(held[i].Body, buffer); err != nil {
			t.Fatal(err)
		}
	}
	if response := f.request(t, "GET", view.ID, "/", "private:1", nil, nil); response.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("third stream: %d", response.StatusCode)
	}
	if response := f.request(t, "GET", other.ID, "/", "private:2", nil, nil); response.StatusCode != 200 {
		t.Fatalf("another owner was throttled: %d", response.StatusCode)
	}
	closeRelease()
	for _, response := range held {
		_, _ = io.ReadAll(response.Body)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		response := f.request(t, "GET", view.ID, "/", "private:1", nil, nil)
		if response.StatusCode == 200 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("slots were not released: %d", response.StatusCode)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestProxyReportsUnreachableAndUnresolvableServices(t *testing.T) {
	f := newProxyFixture(t, ProxyLimits{})
	closed := httptest.NewServer(http.NotFoundHandler())
	port := upstreamPort(t, closed)
	closed.Close()
	view := f.start(t, identity(), "web", &port)
	if response := f.request(t, "GET", view.ID, "/", "private:1", nil, nil); response.StatusCode != http.StatusBadGateway {
		t.Fatalf("closed port: %d", response.StatusCode)
	}
	// An engine without the resolver capability never dials anything.
	plain, _ := newTestService(t)
	name := "web"
	started := bgStart(t, plain, identity(), processStartArguments{Command: "sleep 60", Name: &name, Port: &port})
	t.Cleanup(func() { _, _ = plain.Background.Kill(started.ID, "private:1") })
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest("GET", "/", nil)
	request.Header.Set("X-Owner", "private:1")
	plain.ServeProxy(recorder, request, started.ID, "/")
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("no resolver: %d", recorder.Code)
	}
}

func TestProxyDropsHopByHopResponseHeaders(t *testing.T) {
	f := newProxyFixture(t, ProxyLimits{})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = http.ReadRequest(bufio.NewReader(conn))
				io.WriteString(conn, "HTTP/1.1 200 OK\r\nConnection: X-Hop\r\nX-Hop: dropped\r\nKeep-Alive: timeout=5\r\nX-Kept: yes\r\nContent-Length: 2\r\n\r\nok")
			}()
		}
	}()
	port := listener.Addr().(*net.TCPAddr).Port
	view := f.start(t, identity(), "web", &port)
	response := f.request(t, "GET", view.ID, "/", "private:1", nil, nil)
	if response.Header.Get("X-Hop") != "" || response.Header.Get("Keep-Alive") != "" || response.Header.Get("X-Kept") != "yes" || readBody(t, response) != "ok" {
		t.Fatalf("response headers: %v", response.Header)
	}
}
