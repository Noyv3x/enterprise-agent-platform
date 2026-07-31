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
