import { describe, expect, it } from "vitest";
import { PICK_FIELD_MAX, framePick } from "./WebFrame";

const PICK = { type: "eap-pick", kind: "element", selector: "main > h2", tag: "h2", text: "Pricing", rect: { x: 1, y: 2, w: 3, h: 4 }, path: "index.html", viewport: { w: 1280, h: 800 } };

describe("framePick", () => {
  it("cuts the selector to Platform's limit and drops a pick whose path is longer than it", () => {
    expect(PICK_FIELD_MAX).toBe(500);
    expect(framePick({ ...PICK, selector: "a".repeat(800) })?.selector).toHaveLength(500);
    expect(framePick({ ...PICK, path: "p".repeat(500) })?.path).toHaveLength(500);
    expect(framePick({ ...PICK, path: "p".repeat(501) })).toBeNull();
    expect(framePick({ ...PICK, kind: "region", path: "p".repeat(501) })).toBeNull();
  });

  it("refuses malformed picks", () => {
    expect(framePick({ ...PICK, rect: { x: 0, y: 0, w: 0, h: 4 } })).toBeNull();
    expect(framePick({ ...PICK, kind: "other" })).toBeNull();
    expect(framePick({ ...PICK, viewport: null })).toBeNull();
  });
});
