"use strict";

// @askjo/camofox-browser 1.11.2 omits resetNativeMemBaseline from the
// disabled crash reporter, while closeBrowserFully calls it unconditionally.
// The platform deliberately disables crash reporting, so make that one call
// optional. Keep this patch exact and fail closed if the locked upstream source
// no longer has the expected shape.
const fs = require("node:fs");
const path = require("node:path");

const target = path.join(
  process.cwd(),
  "node_modules",
  "@askjo",
  "camofox-browser",
  "server.js",
);
const gracefulBefore = "reporter.resetNativeMemBaseline();";
const gracefulAfter = "reporter.resetNativeMemBaseline?.();";
const loggingBefore = `function log(level, msg, fields = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    process.stderr.write(line + '\\n');
  } else {
    process.stdout.write(line + '\\n');
  }
}`;
const loggingAfter = `function sanitizeLogUrl(value) {
  const text = String(value || '');
  try {
    const absolute = /^[a-z][a-z0-9+.-]*:\\/\\//i.test(text);
    const parsed = new URL(text, 'http://ubitech.invalid');
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
      return '[redacted-url]';
    }
    const path = parsed.pathname || '/';
    return absolute ? \`\${parsed.protocol}//\${parsed.host}\${path}\` : path;
  } catch (_) {
    return '[invalid-url-redacted]';
  }
}

function sanitizeLogString(value, key) {
  const text = String(value);
  let replacedUrl = false;
  const sanitized = text.replace(
    /(?:https?|wss?):\\/\\/[^\\u0000-\\u0020\\u007f<>"']+/gi,
    (candidate) => {
      replacedUrl = true;
      return sanitizeLogUrl(candidate);
    },
  );
  if (/urls?$/i.test(key) && !replacedUrl) return sanitizeLogUrl(text);
  return sanitized;
}

function sanitizeLogFields(value, key = '', seen = new WeakSet()) {
  if (typeof value === 'string') {
    return sanitizeLogString(value, key);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeLogFields(item, key, seen));
  if (!value || typeof value !== 'object') return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const result = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    result[childKey] = sanitizeLogFields(childValue, childKey, seen);
  }
  seen.delete(value);
  return result;
}

function log(level, msg, fields = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...sanitizeLogFields(fields),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    process.stderr.write(line + '\\n');
  } else {
    process.stdout.write(line + '\\n');
  }
}`;

let patched = fs.readFileSync(target, "utf8");

function applyExactPatch(label, before, after) {
  if (patched.includes(after)) return;
  const matches = patched.split(before).length - 1;
  if (matches !== 1) {
    throw new Error(`expected exactly one ${label} patch target, found ${matches}`);
  }
  patched = patched.replace(before, after);
}

applyExactPatch("graceful-shutdown", gracefulBefore, gracefulAfter);
applyExactPatch("structured-log-redaction", loggingBefore, loggingAfter);

const source = fs.readFileSync(target, "utf8");
if (patched === source) process.exit(0);
const temporary = `${target}.ubitech-patch-${process.pid}`;
fs.writeFileSync(temporary, patched, { encoding: "utf8", mode: 0o644 });
fs.renameSync(temporary, target);
