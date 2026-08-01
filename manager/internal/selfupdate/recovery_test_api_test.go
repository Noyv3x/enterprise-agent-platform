package selfupdate

import "context"

// RecoverCurrent is a test-only adapter. Production has only the API whose
// signature requires the retained handoff authority callback.
func (m *Manager) RecoverCurrent(ctx context.Context, executablePath, platformStatePath, expectedSHA256 string) error {
	return m.RecoverCurrentWithAuthorityTransfer(
		ctx, executablePath, platformStatePath, expectedSHA256, func() error { return nil },
	)
}
