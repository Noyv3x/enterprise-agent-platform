// @vitest-environment node
/// <reference types="node" />

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const globalStyles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
const chatStyles = readFileSync(new URL("./chat.css", import.meta.url), "utf8");

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function declarations(source: string, selector: string): Map<string, string> {
  const selectorPattern = selector
    .trim()
    .split(/\s+/u)
    .map(escapePattern)
    .join("\\s+");
  const match = source.match(new RegExp(`${selectorPattern}\\s*\\{([^}]*)\\}`, "u"));
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

describe("Composer layout contract", () => {
  it("lets the textarea fill the button row without intrinsic-width overflow", () => {
    const field = declarations(globalStyles, ".composer__field");
    const textarea = declarations(globalStyles, ".composer__field textarea");

    expect(field.get("display")).toBe("flex");
    expect(field.get("align-items")).toBe("flex-end");
    expect(field.get("padding")).toBe("7px");
    expect(textarea.get("flex")).toBe("1 1 0");
    expect(textarea.get("min-width")).toBe("0");
  });

  it("keeps compact desktop controls and full-size coarse-pointer targets", () => {
    const selector = ".composer__attach.composer__attach, .composer__send.composer__send";
    const desktop = declarations(chatStyles, selector);
    const coarseStart = chatStyles.indexOf("@media (pointer: coarse)");
    const coarseEnd = chatStyles.indexOf("@media", coarseStart + 1);
    const coarse = declarations(
      chatStyles.slice(coarseStart, coarseEnd === -1 ? undefined : coarseEnd),
      selector,
    );

    expect(desktop.get("width")).toBe("36px");
    expect(desktop.get("height")).toBe("36px");
    expect(coarse.get("width")).toBe("44px");
    expect(coarse.get("min-width")).toBe("44px");
    expect(coarse.get("height")).toBe("44px");
  });
});
