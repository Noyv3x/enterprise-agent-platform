/// <reference types="node" />

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(new URL("./admin.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return stylesheet.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] ?? "";
}

describe("admin layout contracts", () => {
  it("responds to the admin content width instead of only the viewport", () => {
    expect(rule(".admin-panel .admin-page")).toContain("container: admin-page / inline-size");
    expect(stylesheet).toContain("@container admin-page (max-width: 760px)");
    expect(stylesheet).toMatch(
      /@container admin-page \(max-width: 760px\)[\s\S]*?\.admin-panel \.audit-tools,[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/,
    );
    expect(stylesheet).toMatch(
      /@media \(max-width: 1360px\)[\s\S]*?\.admin-panel \.admin-pager--desktop\s*\{\s*display: none/,
    );
  });

  it("preserves intrinsic control proportions", () => {
    const checkboxRule = rule('.admin-panel .check-row input[type="checkbox"]');
    expect(checkboxRule).toContain("width: 18px");
    expect(checkboxRule).toContain("height: 18px");
    expect(checkboxRule).toContain("min-height: 18px");
    expect(rule(".admin-panel .btn.btn--sm")).toContain("min-height: 34px");
    expect(rule(".admin-panel .account-row > .status")).toContain("min-width: max-content");
  });

  it("keeps wide analytics content inside its own region", () => {
    expect(rule(".admin-panel .token-usage__columns")).toContain(
      "grid-template-columns: minmax(0, 1fr)",
    );
    expect(rule(".admin-panel .config-value")).toContain("overflow-wrap: anywhere");
    expect(rule(".admin-panel .audit-message")).toContain(
      "grid-template-columns: minmax(0, 1fr) auto",
    );
    expect(stylesheet).toMatch(
      /@container admin-page \(max-width: 760px\)[\s\S]*?\.admin-panel \.account-row\s*\{\s*grid-template-columns: minmax\(0, 1fr\) max-content/,
    );
    expect(stylesheet).toMatch(
      /@media \(max-width: 360px\)[\s\S]*?\.admin-panel \.account-row__actions\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/,
    );
  });
});
