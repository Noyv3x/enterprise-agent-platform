//go:build linux && arm64

package handoff

import "syscall"

const handoffFstatatSyscall = syscall.SYS_FSTATAT
