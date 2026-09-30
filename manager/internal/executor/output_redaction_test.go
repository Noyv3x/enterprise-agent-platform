package executor

import (
	"bytes"
	"strings"
	"testing"
)

func TestOutputRedactorChunkBoundaries(t *testing.T) {
	cases := []struct{ input, secret, visible string }{
		{"before\nAuthorization: Bearer bearer-credential\nafter\n", "bearer-credential", "after"},
		{"before\nCookie: sid=cookie-credential; other=second-cookie\nafter\n", "cookie-credential", "after"},
		{"before API_TOKEN=assignment-credential after\n", "assignment-credential", "after"},
		{`before {"client_secret":"quoted credential with spaces"} after`, "quoted credential", "after"},
		{"before https://user:url-credential@example.com/path after", "url-credential", "/path after"},
		{"before https://userinfo-credential@example.com/path after", "userinfo-credential", "/path after"},
		{"before https://example.com/path?access_token=query-credential&count=7 after", "query-credential", "&count=7 after"},
		{"before sk-providerCredential123456 after", "providerCredential123456", "after"},
		{"before -----BEGIN PRIVATE KEY-----\nprivate-key-credential\n-----END PRIVATE KEY----- after", "private-key-credential", "after"},
		{"before --password command-credential after", "command-credential", "after"},
		{"before https://user:unfinished-credential", "unfinished-credential", "before"},
		{"before AIzaBareCredential after", "BareCredential", "after"},
		{"before gAAAABareCredential after", "BareCredential", "after"},
		{"before AKIABareCredential after", "BareCredential", "after"},
		{"before eyJBareCredential after", "BareCredential", "after"},
		{"before aUtHoRiZaTiOn \tBearer mixed-credential\nafter", "mixed-credential", "after"},
		{"before bEaReR\t mixed-credential after", "mixed-credential", "after"},
		{"before CoOkIe\t: mixed-credential\nafter", "mixed-credential", "after"},
		{"before X-Goog-Api-Key\t: mixed-credential after", "mixed-credential", "after"},
		{"before ?code=query-credential&ordinary=1", "query-credential", "&ordinary=1"},
		{"before bot12345678:numeric-credential after", "numeric-credential", "after"},
		{"before ſecret=folded-credential after", "folded-credential", "after"},
		{"before ToKeN" + strings.Repeat(" \t", 128) + "space-credential after", "space-credential", "after"},
		{"before CoOkIe" + strings.Repeat("\t ", 128) + "space-credential\nafter", "space-credential", "after"},
	}
	for _, test := range cases {
		for split := 0; split <= len(test.input); split++ {
			var result bytes.Buffer
			var redactor outputRedactor
			emit := func(p []byte) { _, _ = result.Write(p) }
			redactor.Write([]byte(test.input[:split]), emit)
			redactor.Write([]byte(test.input[split:]), emit)
			redactor.Flush(emit)
			got := result.String()
			if strings.Contains(got, test.secret) || !strings.Contains(got, outputRedactionMarker) || !strings.Contains(got, test.visible) {
				t.Fatalf("split %d: unsafe or lost ordinary output: %q", split, got)
			}
		}
	}
}

func TestOutputRedactorRetainsOrdinaryOutputAndFinalSuffix(t *testing.T) {
	input := strings.Repeat("x", 2048) + strings.Repeat("plain progress with spaces and tabs\t\n", 200) +
		strings.Repeat("plain progress 你好 https://example.com:8443/path\n", 200) + "last partial line"
	var result bytes.Buffer
	var redactor outputRedactor
	emit := func(p []byte) { _, _ = result.Write(p) }
	for _, b := range []byte(input) {
		redactor.Write([]byte{b}, emit)
	}
	if result.Len() == 0 {
		t.Fatal("ordinary progress was withheld until EOF")
	}
	redactor.Flush(emit)
	if result.String() != input {
		t.Fatal("ordinary output changed")
	}
	redactor.Flush(emit)
	if result.String() != input {
		t.Fatal("EOF flush duplicated output")
	}
}

func TestOutputRedactorLongSecretsBeforeRetentionClipping(t *testing.T) {
	for _, prefix := range []string{"TOKEN=", "Authorization: Bearer ", "https://user:", "-----BEGIN PRIVATE KEY-----\n"} {
		var redactor outputRedactor
		var retained bytes.Buffer
		emit := func(p []byte) {
			if bytes.Contains(p, []byte("credential")) {
				t.Fatal("secret reached retention sink before clipping")
			}
			remaining := 23 - retained.Len()
			if remaining > 0 {
				_, _ = retained.Write(p[:min(remaining, len(p))])
			}
		}
		redactor.Write([]byte(prefix), emit)
		for range 4096 {
			redactor.Write([]byte("credential"), emit)
			if len(redactor.pending) > outputRedactionWindow {
				t.Fatal("unbounded undecided credential")
			}
		}
		redactor.Flush(emit)
		if strings.Contains(retained.String(), "credential") {
			t.Fatal("clipped output retained credential")
		}
	}
}

func TestOutputRedactorPreviewDoesNotConsumePending(t *testing.T) {
	var redactor outputRedactor
	var committed bytes.Buffer
	emit := func(p []byte) { _, _ = committed.Write(p) }
	redactor.Write([]byte("-first"), emit)
	if committed.String()+redactor.Preview() != "-first" {
		t.Fatal("short progress missing")
	}
	redactor.Write([]byte("-second TOKEN=partial"), emit)
	preview := committed.String() + redactor.Preview()
	if !strings.HasPrefix(preview, "-first-second TOKEN=") || strings.Contains(preview, "partial") {
		t.Fatalf("unsafe preview: %q", preview)
	}
	redactor.Write([]byte("-credential done"), emit)
	redactor.Flush(emit)
	if strings.Contains(committed.String(), "partial") || strings.Contains(committed.String(), "credential") || !strings.HasSuffix(committed.String(), " done") {
		t.Fatalf("preview advanced live stream: %q", committed.String())
	}
}

func TestOutputRedactorPreviewWithholdsIncompleteURLAuthority(t *testing.T) {
	var redactor outputRedactor
	var committed bytes.Buffer
	emit := func(p []byte) { _, _ = committed.Write(p) }
	redactor.Write([]byte("before https://secret-user"), emit)
	if strings.Contains(committed.String()+redactor.Preview(), "secret-user") {
		t.Fatal("incomplete userinfo exposed")
	}
	redactor.Write([]byte(":secret-password@host/path after"), emit)
	redactor.Flush(emit)
	if strings.Contains(committed.String(), "secret-") || !strings.HasSuffix(committed.String(), "/path after") {
		t.Fatalf("unsafe completed URL: %q", committed.String())
	}
}

func TestOutputRedactorLongIntroducerWhitespace(t *testing.T) {
	for _, label := range []string{"Authorization", "TOKEN", "API_KEY", "CoOkIe"} {
		var redactor outputRedactor
		var result bytes.Buffer
		emit := func(p []byte) { _, _ = result.Write(p) }
		input := label + strings.Repeat(" \t", 1024) + "= " + strings.Repeat("\t ", 1024) + "hidden-credential\nordinary"
		for _, b := range []byte(input) {
			redactor.Write([]byte{b}, emit)
		}
		redactor.Flush(emit)
		if strings.Contains(result.String(), "hidden-credential") || !strings.HasSuffix(result.String(), "\nordinary") {
			t.Fatalf("unsafe spaced credential: %q", result.String())
		}
	}
}
