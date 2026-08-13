import assert from "node:assert/strict";
import test from "node:test";
import { redactSensitiveText } from "../src/sensitive-text.js";

test("redactSensitiveText covers credential families without erasing continuation ids", () => {
  const samples = [
    ["sk-1234567890abcdefghij", "sk-1234567890abcdefghij"],
    ["AKIA1234567890ABCDEF", "AKIA1234567890ABCDEF"],
    ["xoxb-1234567890-abcdefghij", "xoxb-1234567890-abcdefghij"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmno", "eyJhbGci"],
    ["-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----", "secret-material"],
    ["postgresql://agent:super-secret@database.local/app", "super-secret"],
    ["Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA"],
    ["https://example.test/callback?access_token=opaque-value&next=/done", "opaque-value"],
    ['"api_key": "opaque-json-secret"', "opaque-json-secret"],
    ["client_secret: opaque-yaml-secret", "opaque-yaml-secret"],
  ] as const;
  const safeIds = ["process_0123456789abcdef", "/workspace/reports/final.xlsx", "todo_0123456789abcdef"];
  const redacted = redactSensitiveText([...samples.map(([text]) => text), ...safeIds].join("\n"));
  for (const [, secret] of samples) assert.equal(redacted.includes(secret), false);
  for (const safe of safeIds) assert.equal(redacted.includes(safe), true);
  assert.match(redacted, /\[redacted/);
});
