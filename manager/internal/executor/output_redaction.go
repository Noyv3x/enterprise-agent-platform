package executor

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
)

// Introducers, rather than complete secrets, let both implementations suppress
// arbitrarily long values without retaining them or exposing a partial token.
// Patterns use the common Go/Python ASCII regex subset. Order breaks ties.
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

// The wrapper receives policy as generated code, not a new protocol field.
func sandboxOutputRedactorPython() string {
	policy, _ := json.Marshal(outputRedactionRules)
	return "import json, re\n_OUTPUT_RULES = [(re.compile(p['pattern'].encode('ascii')), p['mode'], p['keep'], p['required_any'].encode('ascii'), p['min_whitespace']) for p in json.loads(" + strconvPythonString(string(policy)) + ")]\n" + outputRedactorPython
}

func strconvPythonString(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

const outputRedactorPython = `
class OutputRedactor:
    def __init__(self):
        self.pending = b''
        self.mode = ''
        self.quote = 0
        self.escaped = False
        self.url_masked = False
        self.previewing = False
    def preview(self):
        clone = OutputRedactor()
        clone.__dict__.update(self.__dict__)
        clone.previewing = True
        return clone.feed(b'', final=True)
    def feed(self, data, final=False):
        output = []
        for offset in range(0, len(data), 512):
            self.pending += data[offset:offset + 512]
            self.drain(False, output)
        if final:
            self.drain(True, output)
        return b''.join(output)
    def drain(self, final, output):
        while self.pending:
            if self.mode == 'pem':
                end = re.search(b'-----END[A-Z ]*PRIVATE KEY-----', self.pending)
                if end:
                    self.pending = self.pending[end.end():]
                    self.mode = ''
                    continue
                self.pending = b'' if final else self.pending[-512:]
                return
            if self.mode == 'url':
                end = next((i for i, b in enumerate(self.pending) if b in b'/?# \t\r\n"\''), -1)
                if end < 0 and self.previewing:
                    if not self.url_masked:
                        output.append(b'[redacted]')
                    self.pending = b''
                    return
                if end < 0 and not final:
                    if len(self.pending) > 512:
                        if not self.url_masked:
                            output.append(b'[redacted]')
                            self.url_masked = True
                        self.pending = b''
                    return
                if end < 0:
                    end = len(self.pending)
                authority = self.pending[:end]
                if not self.url_masked:
                    at = authority.rfind(b'@')
                    colon = authority.rfind(b':')
                    incomplete = colon >= 0 and not authority.startswith(b'[') and bool(authority[colon+1:].strip(b'0123456789'))
                    output.append(b'[redacted]@' + authority[at+1:] if at >= 0 else b'[redacted]' if incomplete else authority)
                self.pending = self.pending[end:]
                self.mode = ''
                self.url_masked = False
                continue
            if self.mode:
                b = self.pending[0]
                if self.mode == 'value':
                    if b in b' \t=:':
                        self.pending = self.pending[1:]
                        continue
                    if b in b'"\'':
                        self.quote = b
                        self.mode = 'quoted'
                        output.append(self.pending[:1])
                        self.pending = self.pending[1:]
                        continue
                    self.mode = 'token'
                if self.mode == 'quoted':
                    self.pending = self.pending[1:]
                    if self.escaped:
                        self.escaped = False
                    elif b == 92:
                        self.escaped = True
                    elif b == self.quote:
                        output.append(bytes([b]))
                        self.mode = ''
                    continue
                stop = b in (b' \t\r\n,;"\'&|<>)}' if self.mode == 'token' else b'\r\n')
                if stop:
                    self.mode = ''
                    continue
                self.pending = self.pending[1:]
                continue
            selected = None
            for pattern, mode, keep, required_any, min_whitespace in _OUTPUT_RULES:
                if not any(b in self.pending for b in required_any):
                    continue
                if min_whitespace and self.pending.count(b' ') + self.pending.count(b'\t') < min_whitespace:
                    continue
                match = pattern.search(self.pending)
                if match and (selected is None or match.start() < selected[0].start()):
                    selected = (match, mode, keep)
            safe = len(self.pending) if final else max(0, len(self.pending) - 512)
            if selected is None or selected[0].start() >= safe:
                output.append(self.pending[:safe])
                self.pending = self.pending[safe:]
                return
            match, mode, keep = selected
            output.append(self.pending[:match.start()])
            if keep:
                output.append(match.group())
            if mode != 'url':
                output.append(b'[redacted]')
            self.pending = self.pending[match.end():]
            self.mode = mode
        if final:
            self.mode = ''
            self.quote = 0
            self.escaped = False
            self.url_masked = False
`
