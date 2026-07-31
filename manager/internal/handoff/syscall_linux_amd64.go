//go:build linux && amd64

package handoff

import "syscall"

const handoffFstatatSyscall = syscall.SYS_NEWFSTATAT
