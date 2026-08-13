// Code generated from docs/contracts/runtime-policy.json by scripts/docs_sync.py; DO NOT EDIT.
package executor

const (
	runtimePolicySchemaVersion            = 1
	runIdleTimeoutDefaultSeconds          = 1800
	runIdleTimeoutMinimumSeconds          = 0
	runIdleTimeoutMaximumSeconds          = 86400
	maxTurnsPerRunDefault                 = 90
	maxTurnsPerRunMinimum                 = 1
	maxTurnsPerRunMaximum                 = 1000
	terminalTimeoutDefaultMilliseconds    = 180000
	terminalTimeoutMinimumMilliseconds    = 100
	terminalTimeoutMaximumMilliseconds    = 3600000
	processWaitTimeoutDefaultMilliseconds = 1800000
	processWaitTimeoutMinimumMilliseconds = 100
	processWaitTimeoutMaximumMilliseconds = 3600000
)
