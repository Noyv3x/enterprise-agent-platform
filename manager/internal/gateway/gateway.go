package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"
	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
)

type StateProvider interface{ State() model.ManagerState }

type Handler struct {
	State    StateProvider
	Proxy    *httputil.ReverseProxy
	profile  identity.Profile
	accessMu sync.RWMutex
	access   AccessPolicy
}

// AccessPolicy is evaluated against the TCP peer address, never client
// forwarding metadata. A nil AllowedRemotePrefixes slice means this handler is
// the primary listener and does not apply an additional source allowlist; an
// empty non-nil slice denies every source.
type AccessPolicy struct {
	AllowedRemotePrefixes  []netip.Prefix
	TrustedIngressPrefixes []netip.Prefix
}

type forwardingContextKey struct{}

type forwardingMetadata struct {
	clientIP string
	proto    string
	host     string
}

func NewHandler(active identity.ActiveProfile, state StateProvider, platformURL string) (*Handler, error) {
	return NewHandlerWithAccess(active, state, platformURL, AccessPolicy{})
}

func NewHandlerWithAccess(active identity.ActiveProfile, state StateProvider, platformURL string, access AccessPolicy) (*Handler, error) {
	profile, err := active.Profile()
	if err != nil {
		return nil, fmt.Errorf("Gateway technical profile: %w", err)
	}
	target, err := url.Parse(platformURL)
	if err != nil {
		return nil, fmt.Errorf("parse platform URL: %w", err)
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		return nil, errors.New("platform URL must use http or https")
	}
	proxy := &httputil.ReverseProxy{Rewrite: func(request *httputil.ProxyRequest) {
		request.SetURL(target)
		request.Out.Host = request.In.Host
		clearForwardingHeaders(request.Out.Header)
		if metadata, ok := request.In.Context().Value(forwardingContextKey{}).(forwardingMetadata); ok {
			request.Out.Header.Set("X-Forwarded-For", metadata.clientIP)
			request.Out.Header.Set("X-Forwarded-Proto", metadata.proto)
			if metadata.host != "" {
				request.Out.Header.Set("X-Forwarded-Host", metadata.host)
			}
		}
	}}
	proxy.ErrorHandler = func(response http.ResponseWriter, request *http.Request, err error) {
		safeHeaders(response.Header())
		response.Header().Set("Content-Type", "text/html; charset=utf-8")
		response.WriteHeader(http.StatusServiceUnavailable)
		_, _ = response.Write([]byte(fallbackPage))
	}
	return &Handler{State: state, Proxy: proxy, profile: profile, access: cloneAccessPolicy(access)}, nil
}

func (h *Handler) SetAccessPolicy(access AccessPolicy) {
	h.accessMu.Lock()
	h.access = cloneAccessPolicy(access)
	h.accessMu.Unlock()
}

func (h *Handler) accessPolicy() AccessPolicy {
	h.accessMu.RLock()
	defer h.accessMu.RUnlock()
	return cloneAccessPolicy(h.access)
}

func cloneAccessPolicy(access AccessPolicy) AccessPolicy {
	return AccessPolicy{
		AllowedRemotePrefixes:  clonePrefixes(access.AllowedRemotePrefixes),
		TrustedIngressPrefixes: clonePrefixes(access.TrustedIngressPrefixes),
	}
}

func clonePrefixes(values []netip.Prefix) []netip.Prefix {
	return slices.Clone(values)
}

func (h *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	peer, ok := remoteAddress(request.RemoteAddr)
	access := h.accessPolicy()
	if !ok || !remoteAllowed(access, peer) {
		safeHeaders(response.Header())
		response.Header().Set("Content-Type", "text/plain; charset=utf-8")
		response.WriteHeader(http.StatusForbidden)
		_, _ = response.Write([]byte("access denied\n"))
		return
	}
	metadata := forwardingMetadataFor(access, request, peer)
	request = request.WithContext(context.WithValue(request.Context(), forwardingContextKey{}, metadata))
	state := h.State.State()
	if request.URL.Path == h.profile.GatewayStatusPath {
		safeHeaders(response.Header())
		response.Header().Set("Content-Type", "application/json")
		response.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(response).Encode(publicState(state))
		return
	}
	if request.URL.Path == h.profile.GatewayHealthPath {
		safeHeaders(response.Header())
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(map[string]any{"healthy": state.PublicState != model.StateFailed, "state": state.PublicState})
		return
	}
	if state.Maintenance || state.PublicState == model.StateUpdating || state.PublicState == model.StateFailed {
		h.maintenance(response, state)
		return
	}
	h.Proxy.ServeHTTP(response, request)
}

func remoteAllowed(access AccessPolicy, address netip.Addr) bool {
	if access.AllowedRemotePrefixes == nil {
		return true
	}
	return prefixContains(access.AllowedRemotePrefixes, address)
}

func forwardingMetadataFor(access AccessPolicy, request *http.Request, peer netip.Addr) forwardingMetadata {
	metadata := forwardingMetadata{
		clientIP: peer.String(),
		proto:    requestProtocol(request),
		host:     safeForwardedHost(request.Host),
	}
	if !prefixContains(access.TrustedIngressPrefixes, peer) {
		return metadata
	}
	if client, ok := forwardedClient(request.Header.Values("X-Forwarded-For"), access.TrustedIngressPrefixes); ok {
		metadata.clientIP = client.String()
	}
	if proto, ok := firstForwardedToken(request.Header.Values("X-Forwarded-Proto")); ok && (proto == "http" || proto == "https") {
		metadata.proto = proto
	}
	if host, ok := firstForwardedToken(request.Header.Values("X-Forwarded-Host")); ok {
		if safe := safeForwardedHost(host); safe != "" {
			metadata.host = safe
		}
	}
	return metadata
}

func requestProtocol(request *http.Request) string {
	if request.TLS != nil {
		return "https"
	}
	return "http"
}

func remoteAddress(value string) (netip.Addr, bool) {
	host, _, err := net.SplitHostPort(strings.TrimSpace(value))
	if err != nil {
		host = strings.Trim(strings.TrimSpace(value), "[]")
	}
	address, err := netip.ParseAddr(host)
	if err != nil || address.Zone() != "" {
		return netip.Addr{}, false
	}
	return address.Unmap(), true
}

func prefixContains(prefixes []netip.Prefix, address netip.Addr) bool {
	address = address.Unmap()
	for _, prefix := range prefixes {
		candidate := prefix
		if prefix.Addr().Is4In6() {
			candidate = netip.PrefixFrom(prefix.Addr().Unmap(), prefix.Bits()-96)
		}
		if candidate.Contains(address) {
			return true
		}
	}
	return false
}

func forwardedClient(values []string, trusted []netip.Prefix) (netip.Addr, bool) {
	parts := splitForwardedValues(values)
	if len(parts) == 0 || len(parts) > 16 {
		return netip.Addr{}, false
	}
	addresses := make([]netip.Addr, 0, len(parts))
	for _, part := range parts {
		address, err := netip.ParseAddr(part)
		if err != nil || address.Zone() != "" {
			return netip.Addr{}, false
		}
		addresses = append(addresses, address.Unmap())
	}
	for index := len(addresses) - 1; index >= 0; index-- {
		if !prefixContains(trusted, addresses[index]) {
			return addresses[index], true
		}
	}
	return netip.Addr{}, false
}

func firstForwardedToken(values []string) (string, bool) {
	parts := splitForwardedValues(values)
	if len(parts) == 0 || len(parts) > 16 {
		return "", false
	}
	return strings.ToLower(parts[0]), true
}

func splitForwardedValues(values []string) []string {
	var result []string
	for _, value := range values {
		for _, part := range strings.Split(value, ",") {
			part = strings.TrimSpace(part)
			if part == "" || len(part) > 512 || strings.ContainsAny(part, "\r\n\x00") {
				return nil
			}
			result = append(result, part)
		}
	}
	return result
}

func safeForwardedHost(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 255 || strings.ContainsAny(value, "\r\n\x00/@\\?#") {
		return ""
	}
	parsed, err := url.Parse("http://" + value)
	if err != nil || parsed.Host != value || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return ""
	}
	return value
}

func clearForwardingHeaders(header http.Header) {
	header.Del("Forwarded")
	header.Del("X-Forwarded-For")
	header.Del("X-Forwarded-Host")
	header.Del("X-Forwarded-Proto")
	header.Del("X-Forwarded-Port")
	header.Del("X-Real-Ip")
}
func (h *Handler) maintenance(response http.ResponseWriter, state model.ManagerState) {
	safeHeaders(response.Header())
	response.Header().Set("Content-Type", "text/html; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Refresh", "5")
	if state.RetryAfterSeconds > 0 {
		response.Header().Set("Retry-After", strconv.Itoa(state.RetryAfterSeconds))
	}
	response.WriteHeader(http.StatusServiceUnavailable)
	_ = maintenanceTemplate.Execute(response, publicState(state))
	_, _ = response.Write([]byte(publicPageLicense))
}
func publicState(state model.ManagerState) map[string]any {
	operationID := state.ActiveOperationID
	if operationID == "" {
		operationID = state.FinalizePendingOperationID
	}
	return map[string]any{"state": state.PublicState, "phase": state.Phase, "operation_id": operationID, "retry_after_seconds": state.RetryAfterSeconds, "updated_at": state.UpdatedAt}
}
func safeHeaders(header http.Header) {
	header.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
	header.Set("Referrer-Policy", "no-referrer")
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("X-Frame-Options", "DENY")
}

func Listener(address string) (net.Listener, error) {
	if os.Getenv("LISTEN_PID") == strconv.Itoa(os.Getpid()) {
		count, _ := strconv.Atoi(os.Getenv("LISTEN_FDS"))
		if count > 0 {
			file := os.NewFile(3, "systemd-listener")
			if file == nil {
				return nil, errors.New("socket activation descriptor is unavailable")
			}
			listener, err := net.FileListener(file)
			_ = file.Close()
			if err != nil {
				return nil, err
			}
			return listener, nil
		}
	}
	return net.Listen("tcp", address)
}

// TCPListener deliberately bypasses systemd socket activation. Only the
// primary listener may own LISTEN_FDS; the optional LAN listener is always a
// separately configured socket.
func TCPListener(address string) (net.Listener, error) { return net.Listen("tcp", address) }
func Server(listener net.Listener, handler http.Handler) *http.Server {
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 15 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 32 << 10}
	go func() { _ = server.Serve(listener) }()
	return server
}

// The offline surface uses the same Beautiful UI foundation without depending
// on the frontend bundle, external assets, script, or mutable branding.
const publicPageLicense = `<!--
Beautiful UI — https://www.beautifului.dev/
Adapted from c99a3586cf4fc093091feb47d3c066da1fb2e342.
MIT License
Copyright (c) 2026 Shane Levine

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
-->`

const publicPageHead = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Agent Platform</title><style>
:root{color-scheme:light;--page:oklch(0.985 0.001 286.376);--canvas:oklch(0.961 0.002 247.84);--surface:oklch(1 0 0);--ink:oklch(0.247 0.006 258.361);--ink-2:oklch(0.506 0.01 264.477);--line:oklch(0.946 0.003 264.542);--line-strong:oklch(0.912 0.005 258.326);--shadow:0 0 0 1px var(--line),0 2px 6px rgb(0 0 0 / .035)}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--page:oklch(0.209 0.004 264.477);--canvas:oklch(0.231 0.004 264.487);--surface:oklch(0.26 0.006 271.191);--ink:oklch(0.964 0.002 247.839);--ink-2:oklch(0.731 0.008 260.731);--line:oklch(0.308 0.006 258.354);--line-strong:oklch(0.356 0.007 264.474);--shadow:0 0 0 1px rgb(255 255 255 / .11),0 2px 6px rgb(0 0 0 / .2)}}
*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;background:var(--page);color:var(--ink);font:14px/1.5 Inter,ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased}main{width:min(100%,480px)}.brand{font-size:13px;font-weight:600;margin:0 0 20px;display:flex;align-items:center;gap:9px}.brand-mark{width:18px;height:18px;border:1px solid var(--line-strong);border-radius:6px;background:var(--surface);box-shadow:inset 0 0 0 4px var(--canvas)}.card{padding:24px;background:var(--surface);border-radius:10px;box-shadow:var(--shadow)}h1{font-size:18px;line-height:1.4;letter-spacing:-.02em;margin:0 0 8px;font-weight:600}p{margin:0;color:var(--ink-2)}dl{margin:20px 0 0;padding-top:16px;border-top:1px solid var(--line);display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 20px;font-size:13px}dt{color:var(--ink-2)}dd{margin:0;text-align:right;overflow-wrap:anywhere;font-family:ui-monospace,monospace}.note{margin-top:16px;font-size:12px}.retry{display:inline-flex;align-items:center;justify-content:center;margin-top:20px;padding:8px 14px;min-height:36px;border:1px solid var(--line-strong);border-radius:8px;color:var(--ink);background:var(--surface);text-decoration:none;font-size:13px;font-weight:500}.retry:hover{background:var(--canvas)}.retry:focus-visible{outline:2px solid var(--ink);outline-offset:3px}@media(pointer:coarse){.retry{min-height:44px}}@media(max-width:480px){body{padding:16px}.card{padding:20px}}
</style></head><body><main><div class="brand"><span class="brand-mark" aria-hidden="true"></span>Agent Platform</div>`

var maintenanceTemplate = template.Must(template.New("maintenance").Parse(publicPageHead + `<section class="card" aria-labelledby="page-title"><h1 id="page-title">系统正在更新</h1><p>更新期间暂时无法使用，完成后此页面会自动恢复。</p><dl><dt>状态</dt><dd>{{.state}}</dd><dt>阶段</dt><dd>{{.phase}}</dd><dt>操作编号</dt><dd>{{.operation_id}}</dd></dl></section><p class="note">此页面会自动刷新，无需重复提交操作。</p></main></body></html>`))

const fallbackPage = publicPageHead + `<section class="card" aria-labelledby="page-title"><h1 id="page-title">服务暂时不可用</h1><p>服务正在恢复，请稍后重试。</p><a class="retry" href="">重试连接</a></section></main></body></html>` + publicPageLicense
