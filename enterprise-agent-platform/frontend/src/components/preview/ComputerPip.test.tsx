// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPreviewFile } from "../../data/previewActions";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { ChatPreviewContext } from "./ChatPreviewContext";
import { ComputerPip } from "./ComputerPip";
import type { ComputerSurface } from "./computer";

vi.mock("./useBrowserPreview", () => ({
  useBrowserPreview: () => ({
    state: { frameUrl: "", tabId: "", error: "", title: "", url: "" },
  }),
}));

vi.mock("./useTerminalPreviews", () => ({
  useTerminalPreviews: () => ({
    state: {
      connection: "connected",
      loading: false,
      error: "",
      capturedAt: "",
      checkedAt: null,
      revision: "",
      processes: [],
    },
    refresh: vi.fn(),
  }),
}));

vi.mock("../../data/previewActions", async () => {
  const actual = await vi.importActual<typeof import("../../data/previewActions")>(
    "../../data/previewActions",
  );
  return { ...actual, fetchPreviewFile: vi.fn() };
});

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
    vi.mocked(fetchPreviewFile).mockReset();
    vi.mocked(fetchPreviewFile).mockResolvedValue({
      workspace_path: "notes.md",
      content: "const answer = 42;",
      truncated: false,
      encoding: "utf-8",
    });
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
    expect(button).toHaveAccessibleDescription("File · Working");
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

  it("shows the real file snapshot in its compact viewport", async () => {
    render(
      <I18nProvider>
        <ChatPreviewContext.Provider value={{
          scope: { scope_type: "private", scope_id: "7" },
          browserDrawerOpen: false,
          computerDrawerOpen: false,
          computerMode: "file",
          computerSurface: {
            ...surface,
            live: false,
            file: {
              ...surface.file,
              status: "completed",
              revision: "write-1:2:completed",
            },
          },
          openComputer: vi.fn(),
          openBrowserAssist: vi.fn(),
        }}
        >
          <ComputerPip />
        </ChatPreviewContext.Provider>
      </I18nProvider>,
    );

    const line = await screen.findByText("const answer = 42;");
    expect(line.closest(".computer-file--compact")).not.toBeNull();
    expect(document.querySelector(".computer-pip__player")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show the AI computer" }))
      .toHaveAccessibleDescription("File · Read only");
  });

  it("shows bounded search hits instead of a generic computer icon", () => {
    render(
      <I18nProvider>
        <ChatPreviewContext.Provider value={{
          scope: { scope_type: "channel", scope_id: "9" },
          browserDrawerOpen: false,
          computerDrawerOpen: false,
          computerMode: "search",
          computerSurface: {
            ...surface,
            mode: "search",
            file: null,
            searchHits: [{
              title: "Platform architecture",
              url: "https://example.test/architecture",
              snippet: "A bounded search result.",
            }],
          },
          openComputer: vi.fn(),
          openBrowserAssist: vi.fn(),
        }}
        >
          <ComputerPip />
        </ChatPreviewContext.Provider>
      </I18nProvider>,
    );

    expect(screen.getByText("Platform architecture")).toBeInTheDocument();
    expect(document.querySelector(".computer-search--compact")).toBeInTheDocument();
    expect(document.querySelector(".computer-pip__idle")).not.toBeInTheDocument();
  });

  it("shows a completed presented page inside the compact viewport", () => {
    render(
      <I18nProvider>
        <ChatPreviewContext.Provider value={{
          scope: { scope_type: "private", scope_id: "7" },
          browserDrawerOpen: false,
          computerDrawerOpen: false,
          computerMode: "present",
          computerSurface: {
            ...surface,
            live: false,
            mode: "present",
            file: null,
            present: {
              workspace_path: "page.html",
              status: "completed",
              revision: "write-html:2:completed",
            },
          },
          openComputer: vi.fn(),
          openBrowserAssist: vi.fn(),
        }}
        >
          <ComputerPip />
        </ChatPreviewContext.Provider>
      </I18nProvider>,
    );

    const frame = screen.getByTitle("Presented page");
    expect(frame.closest(".computer-present--compact")).not.toBeNull();
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(screen.getByRole("button", { name: "Show the AI computer" }))
      .toHaveAccessibleDescription("Page · Read only");
  });

  it("uses the surface step as the compact terminal fallback", () => {
    render(
      <I18nProvider>
        <ChatPreviewContext.Provider value={{
          scope: { scope_type: "private", scope_id: "7" },
          browserDrawerOpen: false,
          computerDrawerOpen: false,
          computerMode: "terminal",
          computerSurface: {
            ...surface,
            live: false,
            mode: "terminal",
            file: null,
            latestStep: {
              tool: "terminal",
              tool_call_id: "quick-terminal",
              tool_status: "completed",
              parameters: { command: "printf ready", cwd: "/workspace" },
              result: "ready\n[exit 0]",
            },
          },
          openComputer: vi.fn(),
          openBrowserAssist: vi.fn(),
        }}
        >
          <ComputerPip />
        </ChatPreviewContext.Provider>
      </I18nProvider>,
    );

    expect(document.querySelector(".terminal-preview-compact__output"))
      .toHaveTextContent("$ printf ready");
    expect(document.querySelector(".terminal-preview-compact__output"))
      .toHaveTextContent("ready");
    expect(screen.getByRole("button", { name: "Show the AI computer" }))
      .toHaveAccessibleDescription("Terminal · Read only");
  });
});
