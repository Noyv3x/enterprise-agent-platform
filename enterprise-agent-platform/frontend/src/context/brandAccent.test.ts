import { describe, expect, it } from "vitest";
import { brandAccentTokens, groundHex, hexContrast } from "./brandAccent";

const BRANDS = ["#1677ff", "#123456", "#ffcc00", "#00ff88", "#ff0000", "#000000", "#ffffff", "#7c3aed", "#f97316"];

describe("brand accent tokens", () => {
  it.each(BRANDS)("keeps accent-ink text at 4.5:1 on page, surface and tint in both themes (%s)", (brand) => {
    const tokens = brandAccentTokens(brand);
    for (const mode of ["light", "dark"] as const) {
      const { accentInk, accentTint, accent } = tokens[mode];
      for (const ground of [groundHex(mode, "page"), groundHex(mode, "surface"), accentTint]) {
        expect(hexContrast(accentInk, ground)).toBeGreaterThanOrEqual(4.5);
      }
      expect(hexContrast(accent, groundHex(mode, "page"))).toBeGreaterThanOrEqual(3);
    }
  });

  it("uses a readable brand color as the light accent unchanged", () => {
    expect(brandAccentTokens("#123456").light).toMatchObject({ accent: "#123456", accentInk: "#123456" });
  });

  it("darkens a light brand color for text instead of giving up on its hue", () => {
    const { accentInk } = brandAccentTokens("#ffcc00").light;
    expect(accentInk).not.toBe("#000000");
    expect(hexContrast(accentInk, "#ffcc00")).toBeGreaterThan(1.5);
  });
});
