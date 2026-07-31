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
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/model"
)

type StateProvider interface{ State() model.ManagerState }

type Handler struct {
	State    StateProvider
	Proxy    *httputil.ReverseProxy
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

func NewHandler(state StateProvider, platformURL string) (*Handler, error) {
	return NewHandlerWithAccess(state, platformURL, AccessPolicy{})
}

func NewHandlerWithAccess(state StateProvider, platformURL string, access AccessPolicy) (*Handler, error) {
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
	return &Handler{State: state, Proxy: proxy, access: cloneAccessPolicy(access)}, nil
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
	if values == nil {
		return nil
	}
	result := make([]netip.Prefix, len(values))
	copy(result, values)
	return result
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
	if request.URL.Path == "/__ubitech/status" {
		safeHeaders(response.Header())
		response.Header().Set("Content-Type", "application/json")
		response.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(response).Encode(publicState(state))
		return
	}
	if request.URL.Path == "/__ubitech/health" {
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

var maintenanceTemplate = template.Must(template.New("maintenance").Parse(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Platform</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f9;color:#18202d;font:16px system-ui,sans-serif}.card{width:min(36rem,calc(100% - 2rem));box-sizing:border-box;background:white;border:1px solid #dde2ea;border-radius:18px;padding:2rem;box-shadow:0 18px 55px #1b2a4015}h1{font-size:1.35rem;margin:0 0 .75rem}.meta{color:#667085;font-size:.9rem;overflow-wrap:anywhere}</style></head><body><main class="card"><h1>系统正在更新</h1><p>更新期间暂时无法使用，完成后此页面会自动恢复。</p><p class="meta">状态：{{.state}} · 阶段：{{.phase}}<br>操作编号：{{.operation_id}}</p></main></body></html>`))

const fallbackPage = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Platform</title></head><body><h1>服务暂时不可用</h1><p>服务正在恢复，请稍后重试。</p></body></html>`
