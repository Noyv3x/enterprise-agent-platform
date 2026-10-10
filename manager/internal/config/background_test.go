package config

import (
	"strings"
	"testing"
)

func TestBackgroundProcessLimitsDefaultParseAndSurviveRender(t *testing.T) {
	base, err := Defaults(testActiveProfile)
	if err != nil {
		t.Fatal(err)
	}
	if base.BackgroundProcessLimit != 16 || base.BackgroundProcessGlobalLimit != 128 {
		t.Fatalf("defaults: %d/%d", base.BackgroundProcessLimit, base.BackgroundProcessGlobalLimit)
	}
	configured, err := loadReader(base, strings.NewReader("background_process_limit = 4\nbackground_process_global_limit = 9\n"))
	if err != nil {
		t.Fatal(err)
	}
	reloaded, err := loadReader(base, strings.NewReader(render(configured)))
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.BackgroundProcessLimit != 4 || reloaded.BackgroundProcessGlobalLimit != 9 {
		t.Fatalf("limits lost on persistence: %d/%d", reloaded.BackgroundProcessLimit, reloaded.BackgroundProcessGlobalLimit)
	}
}

func TestBackgroundProcessLimitsRejectInvalidValues(t *testing.T) {
	base, err := Defaults(testActiveProfile)
	if err != nil {
		t.Fatal(err)
	}
	for _, setting := range []string{
		"background_process_limit = 0", "background_process_limit = -1", "background_process_limit = 2000", `background_process_limit = "x"`,
		"background_process_global_limit = 0", "background_process_global_limit = 5000",
	} {
		if _, err := loadReader(base, strings.NewReader(setting)); err == nil {
			t.Fatalf("accepted %s", setting)
		}
	}
}
