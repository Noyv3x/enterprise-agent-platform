// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function collectSources(root: string, include: (path: string) => boolean): Record<string, string> {
  const sources: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && include(path)) {
        sources[relative(SOURCE_ROOT, path).replace(/\\/g, "/")] = readFileSync(path, "utf8");
      }
    }
  };
  visit(root);
  return sources;
}

const COMPONENT_SOURCES = collectSources(
  resolve(SOURCE_ROOT, "components"),
  (path) => extname(path) === ".tsx",
);
const STYLE_SOURCES = collectSources(SOURCE_ROOT, (path) => extname(path) === ".css");
const MAIN_SOURCE = readFileSync(resolve(SOURCE_ROOT, "main.tsx"), "utf8");
const NATIVE_CONTROL_ALLOWLIST = new Set([
  "components/chat/ComposerField.tsx",
  "components/chat/ComposerTextarea.tsx",
  "components/chat/MentionMenu.tsx",
]);

function sourcePath(path: string): string {
  return path;
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function splitSelectorList(value: string): string[] {
  const selectors: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") depth -= 1;
    else if (character === "," && depth === 0) {
      selectors.push(value.slice(start, index).trim().replace(/\s+/g, " "));
      start = index + 1;
    }
  }
  selectors.push(value.slice(start).trim().replace(/\s+/g, " "));
  return selectors.filter(Boolean);
}

function cssRuleKeys(source: string): string[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const keys: string[] = [];

  const matchingBrace = (open: number): number => {
    let depth = 1;
    let quote = "";
    for (let index = open + 1; index < css.length; index += 1) {
      const character = css[index];
      if (quote) {
        if (character === "\\") index += 1;
        else if (character === quote) quote = "";
      } else if (character === '"' || character === "'") quote = character;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) return index;
    }
    throw new Error("unbalanced CSS block");
  };

  const visit = (start: number, end: number, contexts: string[]) => {
    let cursor = start;
    while (cursor < end) {
      while (cursor < end && /\s|;/.test(css[cursor] || "")) cursor += 1;
      if (cursor >= end) break;
      const open = css.indexOf("{", cursor);
      if (open === -1 || open >= end) break;
      const header = css.slice(cursor, open).trim().replace(/\s+/g, " ");
      const close = matchingBrace(open);
      if (header.startsWith("@")) {
        if (!/^@(?:-\w+-)?keyframes\b/i.test(header)) {
          visit(open + 1, close, [...contexts, header]);
        }
      } else {
        for (const selector of splitSelectorList(header)) {
          keys.push(`${contexts.join(" > ")}|${selector}`);
        }
      }
      cursor = close + 1;
    }
  };

  visit(0, css.length, []);
  return keys;
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

  it("keeps global root tokens in the canonical design-system stylesheet", () => {
    const owners = Object.entries(STYLE_SOURCES)
      .filter(([, source]) => /^:root\s*\{/m.test(withoutComments(source)))
      .map(([path]) => sourcePath(path));

    expect(owners).toEqual(["design-system.css"]);
  });

  it("keeps global entry styles limited to the foundation and shared compositions", () => {
    expect(STYLE_SOURCES["styles.css"]).toBeUndefined();
    expect([...MAIN_SOURCE.matchAll(/import\s+["'](.+?\.css)["']/g)].map((match) => match[1])).toEqual([
      "./design-system.css",
      "./components/ui/platform-components.css",
    ]);
  });

  it("does not define the same selector and responsive context in multiple style owners", () => {
    const ownersByRule = new Map<string, string[]>();
    for (const [path, source] of Object.entries(STYLE_SOURCES)) {
      for (const rule of cssRuleKeys(source)) {
        ownersByRule.set(rule, [...(ownersByRule.get(rule) || []), path]);
      }
    }
    const violations = [...ownersByRule.entries()]
      .filter(([, owners]) => new Set(owners).size > 1)
      .map(([rule, owners]) => `${rule}: ${[...new Set(owners)].join(", ")}`);

    expect(violations).toEqual([]);
  });
});
