package config

import (
	"strings"
	"testing"
	"time"
)

func TestSandboxResourceConfigurationSurvivesRender(t *testing.T) {
	base, err := Defaults(testActiveProfile)
	if err != nil {
		t.Fatal(err)
	}
	configured, err := loadReader(base, strings.NewReader(`sandbox_idle = "12m"
sandbox_agent_memory = "3g"
sandbox_agent_memory_swap = "4g"
sandbox_agent_cpus = "1.5"
sandbox_agent_pids_limit = 512
sandbox_chat_memory = "512m"
sandbox_chat_memory_swap = "1g"
sandbox_chat_cpus = "0.5"
sandbox_chat_pids_limit = 128
sandbox_chat_idle = "2m"
`))
	if err != nil {
		t.Fatal(err)
	}
	reloaded, err := loadReader(base, strings.NewReader(render(configured)))
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.SandboxAgent != (SandboxResources{Memory: "3g", MemorySwap: "4g", CPUs: "1.5", PidsLimit: 512}) || reloaded.SandboxChat != (SandboxResources{Memory: "512m", MemorySwap: "1g", CPUs: "0.5", PidsLimit: 128}) || reloaded.SandboxIdle != 12*time.Minute || reloaded.SandboxChatIdle != 2*time.Minute {
		t.Fatalf("profile configuration lost on persistence: %#v", reloaded)
	}
}

func TestSandboxResourceConfigurationRejectsUnlimitedAndMalformedLimits(t *testing.T) {
	base, err := Defaults(testActiveProfile)
	if err != nil {
		t.Fatal(err)
	}
	for _, setting := range []string{
		`sandbox_agent_memory = "0"`, `sandbox_chat_memory_swap = "-1"`, `sandbox_agent_memory = "2wat"`,
		`sandbox_chat_cpus = "NaN"`, `sandbox_chat_cpus = "Inf"`, `sandbox_agent_cpus = "0"`,
		`sandbox_chat_pids_limit = -1`, `sandbox_agent_pids_limit = 0`, `sandbox_chat_idle = "0s"`,
	} {
		if _, err := loadReader(base, strings.NewReader(setting)); err == nil {
			t.Fatalf("accepted invalid limit %s", setting)
		}
	}
}
