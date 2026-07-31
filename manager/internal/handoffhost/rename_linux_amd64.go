//go:build linux && amd64

package handoffhost

import (
	"syscall"
	"unsafe"
)

const sysRenameat2 = 316

func renameAtNoReplace(directoryFD int, oldName, newName string) error {
	oldPointer, err := syscall.BytePtrFromString(oldName)
	if err != nil {
		return err
	}
	newPointer, err := syscall.BytePtrFromString(newName)
	if err != nil {
		return err
	}
	_, _, errno := syscall.Syscall6(sysRenameat2, uintptr(directoryFD), uintptr(unsafe.Pointer(oldPointer)), uintptr(directoryFD), uintptr(unsafe.Pointer(newPointer)), 1, 0)
	if errno != 0 {
		return errno
	}
	return nil
}
