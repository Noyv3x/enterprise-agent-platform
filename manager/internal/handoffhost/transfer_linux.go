//go:build linux

package handoffhost

import (
	"context"
	"errors"
	"path/filepath"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofffd"
)

type NamedListener = handofffd.NamedListener

// ListenerReceiver binds Accept to one transaction so callers cannot
// accidentally receive descriptors under a different transaction id.
type ListenerReceiver struct {
	transactionID string
	path          string
	receiver      *handofffd.Receiver
}

func TransferSocketPath(transactionDirectory, transactionID string) (string, error) {
	if err := validateCanonicalAbsolute(transactionDirectory, "handoff transaction directory"); err != nil {
		return "", err
	}
	if !transactionPattern.MatchString(transactionID) || filepath.Base(transactionDirectory) != transactionID {
		return "", errors.New("listener transfer directory is not bound to its transaction id")
	}
	path := filepath.Join(transactionDirectory, handofffd.SourceToHelperSocketBasename)
	return path, nil
}

func (host *LinuxHost) OpenListenerReceiver(transactionDirectory, transactionID string) (ListenerAcceptor, error) {
	path, err := TransferSocketPath(transactionDirectory, transactionID)
	if err != nil {
		return nil, err
	}
	receiver, err := handofffd.ListenAtRecovering(transactionDirectory, handofffd.SourceToHelperSocketBasename)
	if err != nil {
		return nil, err
	}
	return &ListenerReceiver{transactionID: transactionID, path: path, receiver: receiver}, nil
}

func (receiver *ListenerReceiver) Path() string {
	if receiver == nil {
		return ""
	}
	return receiver.path
}

func (receiver *ListenerReceiver) Accept(ctx context.Context) ([]NamedListener, error) {
	if receiver == nil || receiver.receiver == nil {
		return nil, errors.New("listener transfer receiver is unavailable")
	}
	return receiver.receiver.Accept(ctx, receiver.transactionID)
}

func (receiver *ListenerReceiver) Close() error {
	if receiver == nil || receiver.receiver == nil {
		return nil
	}
	return receiver.receiver.Close()
}

func (host *LinuxHost) SendListeners(ctx context.Context, transactionDirectory, transactionID string, listeners []NamedListener) error {
	path, err := TransferSocketPath(transactionDirectory, transactionID)
	if err != nil {
		return err
	}
	return handofffd.SendAt(ctx, transactionDirectory, filepath.Base(path), transactionID, listeners)
}
