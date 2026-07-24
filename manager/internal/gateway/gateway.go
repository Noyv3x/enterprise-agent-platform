package gateway

import (
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"time"

	"github.com/ubitech/agent-platform/manager/internal/model"
)

type StateProvider interface{ State() model.ManagerState }

type Handler struct {
	State StateProvider
	Proxy *httputil.ReverseProxy
}

func NewHandler(state StateProvider, platformURL string) (*Handler, error) {
	target, err := url.Parse(platformURL)
	if err != nil {
		return nil, fmt.Errorf("parse platform URL: %w", err)
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		return nil, errors.New("platform URL must use http or https")
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ErrorHandler = func(response http.ResponseWriter, request *http.Request, err error) {
		safeHeaders(response.Header())
		response.Header().Set("Content-Type", "text/html; charset=utf-8")
		response.WriteHeader(http.StatusServiceUnavailable)
		_, _ = response.Write([]byte(fallbackPage))
	}
	return &Handler{State: state, Proxy: proxy}, nil
}
func (h *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
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
func Server(listener net.Listener, handler http.Handler) *http.Server {
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 15 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 32 << 10}
	go func() { _ = server.Serve(listener) }()
	return server
}

var maintenanceTemplate = template.Must(template.New("maintenance").Parse(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ubitech agent</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f9;color:#18202d;font:16px system-ui,sans-serif}.card{width:min(36rem,calc(100% - 2rem));box-sizing:border-box;background:white;border:1px solid #dde2ea;border-radius:18px;padding:2rem;box-shadow:0 18px 55px #1b2a4015}h1{font-size:1.35rem;margin:0 0 .75rem}.meta{color:#667085;font-size:.9rem;overflow-wrap:anywhere}</style></head><body><main class="card"><h1>ubitech agent 正在更新</h1><p>更新期间暂时无法使用，完成后此页面会自动恢复。</p><p class="meta">状态：{{.state}} · 阶段：{{.phase}}<br>操作编号：{{.operation_id}}</p></main></body></html>`))

const fallbackPage = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ubitech agent</title></head><body><h1>ubitech agent 暂时不可用</h1><p>服务正在恢复，请稍后重试。</p></body></html>`
