package selfupdate

import "github.com/Noyv3x/enterprise-agent-platform/manager/internal/identity"

var (
	recoveryWatchdogUnitPrefix        = identity.SourceProfile().WatchdogUnitPrefix
	recoveryCurrentWatchdogUnitPrefix = identity.SourceProfile().RecoveryWatchdogUnitPrefix
)

func sourceManagerBinaryName() string { return identity.SourceProfile().ManagerBinary }

func sourceManagerUnitName() string { return identity.SourceProfile().ManagerUnit }
