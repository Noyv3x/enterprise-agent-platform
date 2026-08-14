// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { PresentComputerView } from "./PresentComputerView";

describe("PresentComputerView", () => {
  beforeEach(() => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("renders a sandboxed iframe without same-origin privileges", () => {
    render(
      <I18nProvider>
        <PresentComputerView scope={{ scope_type: "private", scope_id: "7" }} />
      </I18nProvider>,
    );
    const frame = screen.getByTitle("Presented page");
    expect(frame).toHaveAttribute(
      "src",
      "/api/agent-previews/present?scope_type=private&scope_id=7",
    );
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
  });
});
