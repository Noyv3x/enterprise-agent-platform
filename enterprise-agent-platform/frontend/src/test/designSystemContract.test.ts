// @vitest-environment node

import { describe, expect, it } from "vitest";

const COMPONENT_SOURCES = import.meta.glob<string>("../components/**/*.tsx", {
  eager: true,
  import: "default",
  query: "?raw",
});
const STYLE_SOURCES = import.meta.glob<string>("../**/*.css", {
  eager: true,
  import: "default",
  query: "?raw",
});
const NATIVE_CONTROL_ALLOWLIST = new Set([
  "components/chat/ComposerField.tsx",
  "components/chat/ComposerTextarea.tsx",
  "components/chat/MentionMenu.tsx",
  "components/common/ConfigFieldControl.tsx",
]);

function sourcePath(path: string): string {
  return path.replace(/^\.\.\//, "");
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("frontend design-system boundary", () => {
  it("keeps native controls inside the documented state-machine and config exceptions", () => {
    const violations = Object.entries(COMPONENT_SOURCES)
      .filter(([path]) => !path.endsWith(".test.tsx"))
      .filter(([, source]) => /<(?:button|input|select|textarea)\b/.test(withoutComments(source)))
      .map(([path]) => sourcePath(path))
      .filter((path) => !NATIVE_CONTROL_ALLOWLIST.has(path));

    expect(violations).toEqual([]);
  });

  it("does not reintroduce retired base-class consumers", () => {
    const retired = new Set(["btn", "icon-btn", "modal", "empty", "skeleton", "toast"]);
    const violations = Object.entries(COMPONENT_SOURCES)
      .filter(([path]) => !path.endsWith(".test.tsx"))
      .filter(([, rawSource]) => {
        const source = withoutComments(rawSource);
        return [...source.matchAll(/className="([^"]*)"/g)].some((match) => (
          match[1].split(/\s+/).some((token) => retired.has(token) || [...retired].some((base) => token.startsWith(`${base}--`)))
        ));
      })
      .map(([path]) => sourcePath(path));

    expect(violations).toEqual([]);
  });

  it("styles the configured eap component prefix instead of the library default", () => {
    const violations = Object.entries(STYLE_SOURCES)
      .filter(([, source]) => /\.ant-/.test(withoutComments(source)))
      .map(([path]) => sourcePath(path));

    expect(violations).toEqual([]);
  });
});
