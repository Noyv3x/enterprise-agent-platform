/** Tolerant parse of JSON text that is still being generated (tool_input_delta fragments).
 *
 * Returns the value the text describes so far: unterminated strings keep their decoded prefix, unterminated arrays
 * and objects keep their complete members, and a trailing half-written escape, number, literal or key is dropped.
 * Returns `undefined` when nothing usable has arrived. Complete valid JSON yields exactly `JSON.parse`'s value. */
export function parsePartialJson(text: string): unknown {
  let i = 0;
  const n = text.length;
  const MISSING = Symbol("missing");
  type Parsed = unknown | typeof MISSING;

  const skip = () => {
    while (i < n && (text[i] === " " || text[i] === "\n" || text[i] === "\r" || text[i] === "\t")) i++;
  };

  /** Decodes a string whose opening quote is at `i`; `complete` is false when the text ends inside it. */
  const string = (): { value: string; complete: boolean } => {
    i++;
    let out = "";
    let start = i;
    while (i < n) {
      const c = text[i];
      if (c === '"') {
        out += text.slice(start, i);
        i++;
        return { value: out, complete: true };
      }
      if (c !== "\\") {
        i++;
        continue;
      }
      out += text.slice(start, i);
      const e = text[i + 1];
      if (e === undefined) {
        // A lone trailing backslash is the start of an escape that has not arrived.
        i = n;
        return { value: out, complete: false };
      }
      if (e === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
          i = n;
          return { value: out, complete: false };
        }
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
      } else {
        const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
        out += map[e] ?? e;
        i += 2;
      }
      start = i;
    }
    out += text.slice(start, n);
    return { value: out, complete: false };
  };

  const value = (): Parsed => {
    skip();
    if (i >= n) return MISSING;
    const c = text[i];
    if (c === '"') return string().value;
    if (c === "{") {
      i++;
      const obj: Record<string, unknown> = {};
      for (;;) {
        skip();
        if (i >= n) return obj;
        if (text[i] === "}") {
          i++;
          return obj;
        }
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] !== '"') return obj;
        const key = string();
        if (!key.complete) return obj;
        skip();
        if (text[i] !== ":") return obj;
        i++;
        const member = value();
        if (member === MISSING) return obj;
        obj[key.value] = member;
        skip();
        // Anything but a separator or the closer means the text is malformed or ended mid-member.
        if (i < n && text[i] !== "," && text[i] !== "}") return obj;
      }
    }
    if (c === "[") {
      i++;
      const arr: unknown[] = [];
      for (;;) {
        skip();
        if (i >= n) return arr;
        if (text[i] === "]") {
          i++;
          return arr;
        }
        if (text[i] === ",") {
          i++;
          continue;
        }
        const member = value();
        if (member === MISSING) return arr;
        arr.push(member);
        skip();
        if (i < n && text[i] !== "," && text[i] !== "]") return arr;
      }
    }
    const rest = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 40));
    if (!rest) {
      i = n;
      return MISSING;
    }
    const token = rest[0];
    i += token.length;
    // A trailing number may still grow ("12" → "123"); that is the value so far.
    return JSON.parse(token);
  };

  const result = value();
  return result === MISSING ? undefined : result;
}

/** The arguments object of a partial tool input; non-object input yields an empty record. */
export function partialArgs(text: string): Record<string, unknown> {
  const parsed = parsePartialJson(text);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}
