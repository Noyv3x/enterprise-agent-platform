import { describe, expect, it } from "vitest";
import { parsePartialJson, partialArgs } from "./partialJson";

describe("parsePartialJson", () => {
  it("matches JSON.parse on complete input", () => {
    const value = { path: "a.ts", n: [1, 2.5, -3e2], ok: true, none: null, nested: { s: 'q"\\/\n\t\u00e9😀' } };
    expect(parsePartialJson(JSON.stringify(value))).toEqual(value);
  });

  it("keeps the decoded prefix of an unterminated string", () => {
    expect(parsePartialJson('{"path":"a.ts","content":"line 1\\nline')).toEqual({ path: "a.ts", content: "line 1\nline" });
  });

  it("drops a half-written escape, unicode escape, key, literal or separator instead of corrupting the text", () => {
    expect(parsePartialJson('{"c":"say \\')).toEqual({ c: "say " });
    expect(parsePartialJson('{"c":"say \\"hi\\')).toEqual({ c: 'say "hi' });
    expect(parsePartialJson('{"c":"caf\\u00')).toEqual({ c: "caf" });
    expect(parsePartialJson('{"c":"caf\\u00e9')).toEqual({ c: "café" });
    expect(parsePartialJson('{"a":"x","b')).toEqual({ a: "x" });
    expect(parsePartialJson('{"a":"x","b":')).toEqual({ a: "x" });
    expect(parsePartialJson('{"a":"x","b":tru')).toEqual({ a: "x" });
    expect(parsePartialJson('{"a":"x",')).toEqual({ a: "x" });
  });

  it("keeps complete members of unterminated arrays and objects", () => {
    expect(parsePartialJson('{"edits":[{"oldText":"a","newText":"b"},{"oldText":"c\\n","newTe')).toEqual({ edits: [{ oldText: "a", newText: "b" }, { oldText: "c\n" }] });
    expect(parsePartialJson("[1,2,")).toEqual([1, 2]);
  });

  it("returns nothing for empty or non-JSON text, and an empty record for non-object arguments", () => {
    expect(parsePartialJson("")).toBeUndefined();
    expect(parsePartialJson("  ")).toBeUndefined();
    expect(partialArgs("[1]")).toEqual({});
    expect(partialArgs("")).toEqual({});
  });

  it("is monotonic over every prefix of a document", () => {
    const text = JSON.stringify({ path: "a/b.ts", content: 'x = "1"\n\tünï😀\\', edits: [{ oldText: "a\nb", newText: "c" }] });
    for (let end = 0; end <= text.length; end++) expect(() => parsePartialJson(text.slice(0, end))).not.toThrow();
    expect(parsePartialJson(text)).toEqual(JSON.parse(text));
  });
});
