package config

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

type SandboxResources struct {
	Memory     string
	MemorySwap string
	CPUs       string
	PidsLimit  int
}

func setSandboxResource(resources *SandboxResources, key, value string) error {
	switch key {
	case "memory", "memory_swap":
		text := strings.ToLower(value)
		if len(text) == 0 {
			return fmt.Errorf("sandbox %s must be a positive Docker memory size", key)
		}
		number := text
		if strings.ContainsAny(text[len(text)-1:], "bkmg") {
			number = text[:len(text)-1]
		}
		n, err := strconv.ParseUint(number, 10, 64)
		if err != nil || n == 0 {
			return fmt.Errorf("sandbox %s must be a positive Docker memory size", key)
		}
		if key == "memory" {
			resources.Memory = text
		} else {
			resources.MemorySwap = text
		}
	case "cpus":
		n, err := strconv.ParseFloat(value, 64)
		if err != nil || n <= 0 || math.IsNaN(n) || math.IsInf(n, 0) {
			return fmt.Errorf("sandbox cpus must be positive")
		}
		resources.CPUs = value
	case "pids_limit":
		n, err := strconv.Atoi(value)
		if err != nil || n <= 0 {
			return fmt.Errorf("sandbox pids_limit must be positive")
		}
		resources.PidsLimit = n
	default:
		return fmt.Errorf("unknown sandbox resource %q", key)
	}
	return nil
}
