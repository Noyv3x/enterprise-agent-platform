package executor

import (
	"bytes"
	"regexp"
	"strings"
)

// Introducers, rather than complete secrets, suppress arbitrarily long values
// without retaining them or exposing a partial token. Order breaks ties.
// RequiredAny contains a mandatory punctuation byte, or all case variants of
// one mandatory letter (b/c/z have no non-ASCII Unicode simple-fold variants).
// Provider prefixes all contain -/_/., except AIza/gAAAA/AKIA (A) and eyJ (J).
// The whitespace fallback requires 256 spaces/tabs; counting the whole window
// is deliberately conservative, not an attempt to recognize an introducer.
var outputRedactionRules = []struct {
	Pattern       string `json:"pattern"`
	Mode          string `json:"mode"`
	Keep          bool   `json:"keep"`
	RequiredAny   string `json:"required_any"`
	MinWhitespace int    `json:"min_whitespace"`
}{
	{`(?i)-----BEGIN[A-Z ]*PRIVATE KEY-----`, "pem", false, "-", 0},
	{`(?i)(?:proxy-)?authorization(?:[ \t]*[=:][ \t]*|[ \t]+)`, "line", true, "zZ", 0},
	{`(?i)(?:set-)?cookie(?:[ \t]*:[ \t]*|[ \t]{256})`, "line", true, "cC", 0},
	{`(?i)(?:x[-_])?(?:goog[-_])?(?:api[-_]?key|api[-_]?token|auth[-_]?token|access[-_]?token)[ \t]*:[ \t]*`, "value", true, ":", 0},
	{`(?i)[a-z0-9_.-]*(?:token|password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|credential|cookie|authorization|session|signature|key_material)[a-z0-9_.-]*["']?[ \t]*[=:][ \t]*`, "value", true, "=:", 0},
	{`(?i)[a-z0-9_.-]*(?:token|password|passwd|secret|api[_-]?key|credential|cookie|session)[a-z0-9_.-]*["']?[ \t]{256}`, "value", true, " \t", 256},
	{`(?i)[?&](?:key|code|auth|jwt)=[ \t]*`, "value", true, "=", 0},
	{`(?i)--[a-z0-9_-]*(?:token|password|passwd|secret|api[-_]?key|credential|cookie|auth|session)[a-z0-9_-]*[ \t]+`, "value", true, "-", 0},
	{`(?i)bearer[ \t]+`, "value", true, "bB", 0},
	{`(?i)[a-z][a-z0-9+.-]*://`, "url", true, ":", 0},
	{`(?:sk-|sk_|gh[pousr]_|github_pat_|xapp-[0-9]+-|xox[baprs]-|AIza|pplx-|fal_|fc-|bb_live_|gAAAA|AKIA|(?:sk|rk)_(?:live|test)_|SG\.|hf_|r8_|npm_|pypi-|dop_v1_|doo_v1_|am_|tvly-|exa_|gsk_|xai-|ntn_|fw[-_]|fpk_|eyJ)[A-Za-z0-9_./+=-]`, "token", false, "-_.AJ", 0},
	{`(?:bot)?[0-9]{8,}:`, "token", false, ":", 0},
}

const outputRedactionWindow = 512
const outputRedactionMarker = "[redacted]"

var outputRedactionPatterns = func() []*regexp.Regexp {
	patterns := make([]*regexp.Regexp, len(outputRedactionRules))
	for i, rule := range outputRedactionRules {
		patterns[i] = regexp.MustCompile(rule.Pattern)
	}
	return patterns
}()
var outputPrivateKeyEnd = regexp.MustCompile(`-----END[A-Z ]*PRIVATE KEY-----`)

// outputRedactor is owned by a single stream (or its buffer's mutex). Flush is
// an EOF operation, never a snapshot operation: snapshots must not publish an
// undecided suffix. Raw pending storage is bounded independently of output size.
type outputRedactor struct {
	pending    []byte
	mode       string
	quote      byte
	escaped    bool
	urlMasked  bool
	previewing bool
}

func (r *outputRedactor) Write(p []byte, emit func([]byte)) {
	for len(p) > 0 {
		n := min(len(p), outputRedactionWindow)
		r.pending = append(r.pending, p[:n]...)
		p = p[n:]
		r.drain(false, emit)
	}
}

func (r *outputRedactor) Flush(emit func([]byte)) {
	r.drain(true, emit)
}

// Preview sanitizes the undecided suffix without advancing the stream. The
// copy only reads pending bytes; drain never mutates their backing storage.
func (r *outputRedactor) Preview() string {
	copy := *r
	copy.previewing = true
	var output bytes.Buffer
	copy.Flush(func(p []byte) { _, _ = output.Write(p) })
	return output.String()
}

func (r *outputRedactor) drain(final bool, emit func([]byte)) {
	for len(r.pending) > 0 {
		if r.mode == "pem" {
			if end := outputPrivateKeyEnd.FindIndex(r.pending); end != nil {
				r.pending = r.pending[end[1]:]
				r.mode = ""
				continue
			}
			if final {
				r.pending = nil
			} else if len(r.pending) > outputRedactionWindow {
				r.pending = r.pending[len(r.pending)-outputRedactionWindow:]
			}
			return
		}
		if r.mode == "url" {
			end := bytes.IndexAny(r.pending, "/?# \t\r\n\"'")
			if end < 0 && r.previewing {
				if !r.urlMasked {
					emit([]byte(outputRedactionMarker))
				}
				r.pending = nil
				return
			}
			if end < 0 && !final {
				if len(r.pending) > outputRedactionWindow {
					if !r.urlMasked {
						emit([]byte(outputRedactionMarker))
						r.urlMasked = true
					}
					r.pending = r.pending[:0]
				}
				return
			}
			if end < 0 {
				end = len(r.pending)
			}
			authority := r.pending[:end]
			if !r.urlMasked {
				if at := bytes.LastIndexByte(authority, '@'); at >= 0 {
					emit([]byte(outputRedactionMarker + "@"))
					emit(authority[at+1:])
				} else if colon := bytes.LastIndexByte(authority, ':'); colon >= 0 && !bytes.HasPrefix(authority, []byte("[")) && len(bytes.Trim(authority[colon+1:], "0123456789")) > 0 {
					emit([]byte(outputRedactionMarker))
				} else {
					emit(authority)
				}
			}
			r.pending = r.pending[end:]
			r.mode = ""
			r.urlMasked = false
			continue
		}
		if r.mode != "" {
			b := r.pending[0]
			if r.mode == "value" {
				if b == ' ' || b == '\t' || b == '=' || b == ':' {
					r.pending = r.pending[1:]
					continue
				}
				if b == '\'' || b == '"' {
					r.quote = b
					r.mode = "quoted"
					emit(r.pending[:1])
					r.pending = r.pending[1:]
					continue
				}
				r.mode = "token"
			}
			if r.mode == "quoted" {
				r.pending = r.pending[1:]
				if r.escaped {
					r.escaped = false
				} else if b == '\\' {
					r.escaped = true
				} else if b == r.quote {
					emit([]byte{b})
					r.mode = ""
				}
				continue
			}
			stop := b == '\n' || b == '\r'
			if r.mode == "token" {
				stop = strings.ContainsRune(" \t\r\n,;\"'&|<>)}", rune(b))
			}
			if stop {
				r.mode = ""
				continue
			}
			r.pending = r.pending[1:]
			continue
		}
		start, end, ruleIndex := len(r.pending), 0, -1
		for i, pattern := range outputRedactionPatterns {
			rule := outputRedactionRules[i]
			possible := false
			for j := range rule.RequiredAny {
				if bytes.IndexByte(r.pending, rule.RequiredAny[j]) >= 0 {
					possible = true
					break
				}
			}
			if !possible {
				continue
			}
			if rule.MinWhitespace > 0 && bytes.Count(r.pending, []byte(" "))+bytes.Count(r.pending, []byte("\t")) < rule.MinWhitespace {
				continue
			}
			if match := pattern.FindIndex(r.pending); match != nil && match[0] < start {
				start, end, ruleIndex = match[0], match[1], i
			}
		}
		// Only commit matches whose start is outside the undecided suffix.
		// This prevents a shorter match winning before a longer introducer arrives.
		safe := len(r.pending)
		if !final {
			safe -= outputRedactionWindow
			if safe < 0 {
				safe = 0
			}
		}
		if ruleIndex < 0 || start >= safe {
			if safe > 0 {
				emit(r.pending[:safe])
				r.pending = r.pending[safe:]
			}
			return
		}
		emit(r.pending[:start])
		rule := outputRedactionRules[ruleIndex]
		if rule.Keep {
			emit(r.pending[start:end])
		}
		if rule.Mode != "url" {
			emit([]byte(outputRedactionMarker))
		}
		r.pending = r.pending[end:]
		r.mode = rule.Mode
	}
	if final {
		r.mode = ""
		r.quote = 0
		r.escaped = false
		r.urlMasked = false
	}
}

func redactRetainedText(value string) string {
	var output bytes.Buffer
	var redactor outputRedactor
	emit := func(p []byte) { _, _ = output.Write(p) }
	redactor.Write([]byte(value), emit)
	redactor.Flush(emit)
	return output.String()
}
