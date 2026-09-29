package main

import (
	"net/http"
	"sync/atomic"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/control"
)

type atomicControlHandler struct {
	active atomic.Pointer[controlHandlerSnapshot]
}

type controlHandlerSnapshot struct {
	handler http.Handler
}

func newServeControlHandler(full *control.API, pendingActivation bool) *atomicControlHandler {
	initial := http.Handler(full)
	if pendingActivation {
		initial = &control.API{
			ControlToken:   full.ControlToken,
			ManagerVersion: full.ManagerVersion,
			ManagerSHA256:  full.ManagerSHA256,
			IdentityOnly:   true,
		}
	}
	return newAtomicControlHandler(initial)
}

func newAtomicControlHandler(initial http.Handler) *atomicControlHandler {
	handler := &atomicControlHandler{}
	handler.active.Store(&controlHandlerSnapshot{handler: initial})
	return handler
}

func (h *atomicControlHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	snapshot := h.active.Load()
	if snapshot == nil || snapshot.handler == nil {
		http.Error(response, "Manager control handler is unavailable", http.StatusServiceUnavailable)
		return
	}
	snapshot.handler.ServeHTTP(response, request)
}

func (h *atomicControlHandler) promote(full *control.API) {
	h.active.Store(&controlHandlerSnapshot{handler: full})
}

// A committed or fallback Manager must let Platform inspect the durable gate
// while recovering it. Only this authenticated read is opened before boot proof;
// mutations, configuration and executor capabilities remain fenced.
func (h *atomicControlHandler) allowRecoveryStatus(full *control.API) {
	fenced := h.active.Load().handler
	h.active.Store(&controlHandlerSnapshot{handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodGet && request.URL.Path == "/v1/status" {
			full.ServeHTTP(response, request)
			return
		}
		fenced.ServeHTTP(response, request)
	})})
}
