// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { ChatPreviewContext } from "./ChatPreviewContext";
import { ComputerPip } from "./ComputerPip";
import type { ComputerSurface } from "./computer";

vi.mock("./useBrowserPreview", () => ({
  useBrowserPreview: () => ({
    state: { frameUrl: "", tabId: "", error: "", title: "", url: "" },
  }),
}));

const surface: ComputerSurface = {
  visible: true,
  live: true,
  mode: "file",
  file: { workspace_path: "notes.md", path: "notes.md", target: "sandbox" },
  searchHits: [],
  searchTool: "",
  present: null,
};

describe("ComputerPip", () => {
  beforeEach(() => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("stays hidden when the computer surface is idle", () => {
    render(
      <I18nProvider>
        <ChatPreviewContext.Provider value={{
          scope: { scope_type: "private", scope_id: "7" },
          browserDrawerOpen: false,
          computerDrawerOpen: false,
          computerMode: null,
          computerSurface: { ...surface, visible: false, live: false, mode: null },
          openComputer: vi.fn(),
          openBrowserAssist: vi.fn(),
        }}
        >
          <ComputerPip />
        </ChatPreviewContext.Provider>
      </I18nProvider>,
    );
    expect(screen.queryByRole("button", { name: "Show the AI computer" })).not.toBeInTheDocument();
  });

  it("opens the read-only computer and does not take control", async () => {
    const openComputer = vi.fn();
    const openBrowserAssist = vi.fn();
    render(
      <I18nProvider>
        <ChatPreviewContext.Provider value={{
          scope: { scope_type: "private", scope_id: "7" },
          browserDrawerOpen: false,
          computerDrawerOpen: false,
          computerMode: "file",
          computerSurface: surface,
          openComputer,
          openBrowserAssist,
        }}
        >
          <ComputerPip />
        </ChatPreviewContext.Provider>
      </I18nProvider>,
    );
    const button = screen.getByRole("button", { name: "Show the AI computer" });
    expect(button).toBeVisible();
    expect(screen.getByText("AI computer")).toBeVisible();
    await userEvent.click(button);
    expect(openComputer).toHaveBeenCalledTimes(1);
    expect(openBrowserAssist).not.toHaveBeenCalled();
  });

  it("unmounts when the computer drawer is open", () => {
    render(
      <I18nProvider>
        <ChatPreviewContext.Provider value={{
          scope: { scope_type: "private", scope_id: "7" },
          browserDrawerOpen: true,
          computerDrawerOpen: true,
          computerMode: "browser",
          computerSurface: { ...surface, mode: "browser" },
          openComputer: vi.fn(),
          openBrowserAssist: vi.fn(),
        }}
        >
          <ComputerPip />
        </ChatPreviewContext.Provider>
      </I18nProvider>,
    );
    expect(screen.queryByRole("button", { name: "Show the AI computer" })).not.toBeInTheDocument();
  });
});
