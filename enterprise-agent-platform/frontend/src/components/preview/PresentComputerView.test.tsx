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

  it("does not mount the iframe until an HTML write completes", () => {
    const scope = { scope_type: "private" as const, scope_id: "7" };
    const rendered = render(
      <I18nProvider>
        <PresentComputerView
          scope={scope}
          present={{
            workspace_path: "page.html",
            status: "running",
            revision: "write-1:1:running",
          }}
        />
      </I18nProvider>,
    );

    expect(screen.queryByTitle("Presented page")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");

    rendered.rerender(
      <I18nProvider>
        <PresentComputerView
          scope={scope}
          present={{
            workspace_path: "page.html",
            status: "completed",
            revision: "write-1:2:completed",
          }}
        />
      </I18nProvider>,
    );

    expect(screen.getByTitle("Presented page")).toBeInTheDocument();
  });

  it("replaces the iframe after a completed same-path rewrite", () => {
    const scope = { scope_type: "private" as const, scope_id: "7" };
    const rendered = render(
      <I18nProvider>
        <PresentComputerView
          scope={scope}
          present={{
            workspace_path: "page.html",
            status: "completed",
            revision: "write-1:2:completed",
          }}
        />
      </I18nProvider>,
    );
    const firstFrame = screen.getByTitle("Presented page");

    rendered.rerender(
      <I18nProvider>
        <PresentComputerView
          scope={scope}
          present={{
            workspace_path: "page.html",
            status: "completed",
            revision: "patch-2:5:completed",
          }}
        />
      </I18nProvider>,
    );

    expect(screen.getByTitle("Presented page")).not.toBe(firstFrame);
  });

  it("replaces the iframe when a path-only present clue changes", () => {
    const scope = { scope_type: "private" as const, scope_id: "7" };
    const rendered = render(
      <I18nProvider>
        <PresentComputerView
          scope={scope}
          present={{ workspace_path: "first.html", status: "completed" }}
        />
      </I18nProvider>,
    );
    const firstFrame = screen.getByTitle("Presented page");

    rendered.rerender(
      <I18nProvider>
        <PresentComputerView
          scope={scope}
          present={{ workspace_path: "second.html", status: "completed" }}
        />
      </I18nProvider>,
    );

    expect(screen.getByTitle("Presented page")).not.toBe(firstFrame);
  });

  it("replaces the iframe when an attachment-only present clue changes", () => {
    const scope = { scope_type: "private" as const, scope_id: "7" };
    const rendered = render(
      <I18nProvider>
        <PresentComputerView
          scope={scope}
          present={{ attachment_id: 11, status: "completed" }}
        />
      </I18nProvider>,
    );
    const firstFrame = screen.getByTitle("Presented page");

    rendered.rerender(
      <I18nProvider>
        <PresentComputerView
          scope={scope}
          present={{ attachment_id: 12, status: "completed" }}
        />
      </I18nProvider>,
    );

    expect(screen.getByTitle("Presented page")).not.toBe(firstFrame);
  });
});
