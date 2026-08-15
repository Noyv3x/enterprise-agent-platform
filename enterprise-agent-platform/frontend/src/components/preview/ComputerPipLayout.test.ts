// @vitest-environment node
/// <reference types="node" />

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const previewStyles = readFileSync(new URL("./preview.css", import.meta.url), "utf8");

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function declarations(selector: string): Map<string, string> {
  const selectorPattern = selector
    .trim()
    .split(/\s+/u)
    .map(escapePattern)
    .join("\\s+");
  const match = previewStyles.match(new RegExp(`${selectorPattern}\\s*\\{([^}]*)\\}`, "u"));
  expect(match, `missing CSS rule for ${selector}`).not.toBeNull();
  return new Map(
    (match?.[1] || "")
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf(":");
        return [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()];
      }),
  );
}

describe("Computer PiP layout contract", () => {
  it("is a right-aligned mini 16:9 player instead of a full-width banner", () => {
    const host = declarations(".computer-pip");
    const player = declarations(".computer-pip__player");
    const button = declarations(".computer-pip__button.computer-pip__button");

    expect(host.get("justify-self")).toBe("end");
    expect(host.get("width")).toBe("clamp(184px, 20vw, 232px)");
    expect(host.get("margin-right")).toContain("860px");
    expect(player.get("aspect-ratio")).toBe("16 / 9");
    expect(button.get("width")).toBe("100%");
    expect(button.get("height")).toBe("100%");
    expect(previewStyles).not.toContain("aspect-ratio: 16 / 7");
    expect(previewStyles).not.toContain("width: min(860px, 100%)");
  });

  it("provides real-snapshot animation with an explicit reduced-motion fallback", () => {
    expect(previewStyles).toContain("@keyframes computer-file-line-reveal");
    expect(previewStyles).toContain("@keyframes computer-file-line-change");
    expect(previewStyles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(previewStyles).toContain(".computer-file__line.is-changed");
    expect(previewStyles).toContain("animation: none !important");
  });
});
