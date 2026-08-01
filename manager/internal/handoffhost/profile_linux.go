//go:build linux

package handoffhost

import "github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"

// Kept behind one tiny function so all host validation consumes the same
// compile-time target profile instead of reproducing namespace constants.
func identityTargetProfile() identity.Profile { return identity.TargetProfile() }
