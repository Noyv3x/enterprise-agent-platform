// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import type { AgentPreviewScope } from "../../types";
import { ChatPreviewSidebar } from "./ChatPreviewSidebar";

const mocks = vi.hoisted(() => ({
  availability: {
    browserActive: false,
    runningTerminalCount: 0,
  },
  browserRender: vi.fn(),
  terminalRender: vi.fn(),
}));

vi.mock("./usePreviewAvailability", () => ({
  usePreviewAvailability: () => ({
    state: {
      ...mocks.availability,
      loading: false,
      error: "",
    },
    refresh: vi.fn(),
  }),
}));

vi.mock("./BrowserPreviewView", () => ({
  BrowserPreviewView: () => {
    mocks.browserRender();
    return <div data-testid="browser-preview-fixture" />;
  },
}));

vi.mock("./TerminalPreviewView", () => ({
  TerminalPreviewView: () => {
    mocks.terminalRender();
    return <div data-testid="terminal-preview-fixture" />;
  },
}));

const privateScope: AgentPreviewScope = { scope_type: "private", scope_id: "7" };

function renderSidebar(scope: AgentPreviewScope | null = privateScope) {
  return render(
    <I18nProvider>
      <ChatPreviewSidebar scope={scope}>
        <div>Chat content</div>
      </ChatPreviewSidebar>
    </I18nProvider>,
  );
}

describe("ChatPreviewSidebar", () => {
  beforeEach(() => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    mocks.availability.browserActive = false;
    mocks.availability.runningTerminalCount = 0;
    mocks.browserRender.mockClear();
    mocks.terminalRender.mockClear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("keeps the chat visible without rendering preview controls when resources are idle", () => {
    renderSidebar();

    expect(screen.getByText("Chat content")).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "Live previews" })).not.toBeInTheDocument();
    expect(mocks.browserRender).not.toHaveBeenCalled();
    expect(mocks.terminalRender).not.toHaveBeenCalled();
  });

  it("shows only the active browser control and mounts the full preview on demand", async () => {
    mocks.availability.browserActive = true;
    renderSidebar();

    const browserButton = screen.getByRole("button", { name: "Open browser preview" });
    expect(screen.queryByRole("button", { name: /Open terminal preview/ })).not.toBeInTheDocument();
    expect(mocks.browserRender).not.toHaveBeenCalled();

    await userEvent.click(browserButton);

    expect(browserButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("complementary", { name: "Live browser preview" })).toBeVisible();
    expect(screen.getByTestId("browser-preview-fixture")).toBeVisible();
    expect(mocks.browserRender).toHaveBeenCalled();
  });

  it("shows the running terminal count and closes the drawer as soon as terminals finish", async () => {
    mocks.availability.browserActive = true;
    mocks.availability.runningTerminalCount = 2;
    const view = renderSidebar();

    await userEvent.click(screen.getByRole("button", { name: "Open terminal previews (2)" }));
    expect(screen.getByRole("complementary", { name: "Live terminal preview" })).toBeVisible();
    expect(screen.getByTestId("terminal-preview-fixture")).toBeVisible();

    mocks.availability.runningTerminalCount = 0;
    view.rerender(
      <I18nProvider>
        <ChatPreviewSidebar scope={privateScope}>
          <div>Chat content</div>
        </ChatPreviewSidebar>
      </I18nProvider>,
    );

    expect(screen.queryByRole("button", { name: /Open terminal preview/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open browser preview" })).toBeVisible();
  });

  it("closes an open preview when the active chat scope changes", async () => {
    mocks.availability.browserActive = true;
    const view = renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "Open browser preview" }));
    expect(screen.getByRole("complementary")).toBeVisible();

    view.rerender(
      <I18nProvider>
        <ChatPreviewSidebar scope={{ scope_type: "channel", scope_id: "4" }}>
          <div>Other chat</div>
        </ChatPreviewSidebar>
      </I18nProvider>,
    );

    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.getByText("Other chat")).toBeVisible();
  });
});
