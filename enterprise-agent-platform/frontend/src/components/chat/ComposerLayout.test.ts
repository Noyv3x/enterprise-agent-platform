// @vitest-environment node
/// <reference types="node" />

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
    const field = declarations(chatStyles, ".composer__field");
    const textarea = declarations(chatStyles, ".composer__field textarea");

    expect(field.get("display")).toBe("flex");
    expect(field.get("align-items")).toBe("flex-end");
    expect(field.get("padding")).toBe("2px");
    expect(field.get("border")).toBe("0");
    expect(field.get("background")).toBe("transparent");
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

  it("targets the configured Ant Design prefix for upload progress", () => {
    expect(chatStyles).toContain(".msg-upload .eap-progress");
    expect(chatStyles).not.toContain(".msg-upload .ant-progress");
  });

  it("removes decorative work-card sweeps and provides local reduced motion", () => {
    const sweep = declarations(chatStyles, ".agent-work--active .agent-work__summary::after");

    expect(sweep.get("display")).toBe("none");
    expect(chatStyles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(chatStyles).toContain("transition-duration: 0.001ms !important");
  });
});
