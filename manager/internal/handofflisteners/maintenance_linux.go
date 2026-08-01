//go:build linux

package handofflisteners

import (
	"errors"
	"net"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofffd"
)

const neutralMaintenancePage = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Maintenance</title></head><body><main><h1>Service temporarily unavailable</h1><p>Maintenance is in progress. This page will recover automatically.</p></main></body></html>`

// maintenanceGroup accepts through disposable duplicates of the helper's
// original listener descriptors. Closing the HTTP servers therefore stops
// every helper Accept loop without relinquishing the descriptors transferred
// by SCM_RIGHTS or recreated under the durable bind lock.
type maintenanceGroup struct {
	servers []*http.Server
	done    []<-chan error
	once    sync.Once
	err     error
}

func startMaintenance(listeners []handofffd.NamedListener, expected []handofffd.ListenerIdentity) (*maintenanceGroup, error) {
	if err := describeExact(listeners, expected); err != nil {
		return nil, err
	}
	group := &maintenanceGroup{}
	for _, named := range listeners {
		tcp, ok := named.Listener.(*net.TCPListener)
		if !ok || tcp == nil {
			_ = group.Close()
			return nil, errors.New("maintenance listener is not TCP")
		}
		file, err := tcp.File()
		if err != nil {
			_ = group.Close()
			return nil, err
		}
		duplicate, err := net.FileListener(file)
		_ = file.Close()
		if err != nil {
			_ = group.Close()
			return nil, err
		}
		server := &http.Server{
			Handler:           http.HandlerFunc(serveNeutralMaintenance),
			ReadHeaderTimeout: 10 * time.Second,
			IdleTimeout:       30 * time.Second,
			MaxHeaderBytes:    16 << 10,
		}
		finished := make(chan error, 1)
		group.servers = append(group.servers, server)
		group.done = append(group.done, finished)
		go func(listener net.Listener, result chan<- error) {
			result <- server.Serve(listener)
		}(duplicate, finished)
	}
	return group, nil
}

func serveNeutralMaintenance(response http.ResponseWriter, _ *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'")
	response.Header().Set("Content-Type", "text/html; charset=utf-8")
	response.Header().Set("Referrer-Policy", "no-referrer")
	response.Header().Set("Retry-After", "3")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.Header().Set("X-Frame-Options", "DENY")
	response.WriteHeader(http.StatusServiceUnavailable)
	_, _ = response.Write([]byte(neutralMaintenancePage))
}

func (group *maintenanceGroup) Close() error {
	if group == nil {
		return nil
	}
	group.once.Do(func() {
		for _, server := range group.servers {
			if err := server.Close(); err != nil && !errors.Is(err, http.ErrServerClosed) && !errors.Is(err, net.ErrClosed) && !errors.Is(err, os.ErrClosed) {
				group.err = errors.Join(group.err, err)
			}
		}
		for _, finished := range group.done {
			err := <-finished
			if err != nil && !errors.Is(err, http.ErrServerClosed) && !errors.Is(err, net.ErrClosed) && !errors.Is(err, os.ErrClosed) {
				group.err = errors.Join(group.err, err)
			}
		}
	})
	return group.err
}
