// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPreviewFile } from "../../data/previewActions";
import { LOCALE_STORAGE_KEY } from "../../i18n";
import { TestUiProviders } from "../../test/TestUiProviders";
import { ChatPreviewContext } from "./ChatPreviewContext";
import { ComputerPip } from "./ComputerPip";
import type { ComputerSurface } from "./computer";
import type { AgentPreviewFileResponse } from "../../types";

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
  runId: "run-1",
  startedAt: null,
  mode: "file",
  file: { workspace_path: "notes.md", path: "notes.md", target: "sandbox" },
  searchHits: [],
  searchTool: "",
  present: null,
};

const defaultMatchMedia = window.matchMedia;

describe("ComputerPip", () => {
  beforeEach(() => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string): MediaQueryList => ({
        matches: query === "(prefers-reduced-motion: reduce)",
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
    vi.mocked(fetchPreviewFile).mockReset();
    vi.mocked(fetchPreviewFile).mockResolvedValue({
      workspace_path: "notes.md",
      content: "const answer = 42;",
      truncated: false,
      encoding: "utf-8",
      source: "workspace",
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    localStorage.clear();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: defaultMatchMedia,
    });
  });

  it("ticks from the authoritative run start, hides when non-live, and resets for a new run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T12:00:05.000Z"));
    const context = (computerSurface: ComputerSurface) => ({
      scope: { scope_type: "private" as const, scope_id: "7" },
      capabilityActions: null,
      browserDrawerOpen: false,
      computerDrawerOpen: false,
      computerMode: "search" as const,
      computerSurface,
      openComputer: vi.fn(),
      openBrowserAssist: vi.fn(),
    });
    const liveSurface: ComputerSurface = {
      ...surface,
      mode: "search",
      file: null,
      searchHits: [{ title: "Live result" }],
      runId: "run-timed-1",
      startedAt: Date.parse("2026-08-15T12:00:00.000Z") / 1_000,
    };
    const rendered = render(
      <TestUiProviders>
        <ChatPreviewContext.Provider value={context(liveSurface)}>
          <ComputerPip />
        </ChatPreviewContext.Provider>
      </TestUiProviders>,
    );

    expect(screen.getByText("Elapsed 00:05")).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText("Elapsed 00:06")).toBeVisible();

    rendered.rerender(
      <TestUiProviders>
        <ChatPreviewContext.Provider value={context({ ...liveSurface, live: false })}>
          <ComputerPip />
        </ChatPreviewContext.Provider>
      </TestUiProviders>,
    );
    expect(screen.queryByText("Elapsed 00:06")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show the AI computer" })).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.queryByText(/^Elapsed /)).not.toBeInTheDocument();

    const nextStartedAt = Date.now() / 1_000;
    rendered.rerender(
      <TestUiProviders>
        <ChatPreviewContext.Provider value={context({
          ...liveSurface,
          runId: "run-timed-2",
          startedAt: nextStartedAt,
        })}>
          <ComputerPip />
        </ChatPreviewContext.Provider>
      </TestUiProviders>,
    );
    expect(screen.getByText("Elapsed 00:00")).toBeVisible();
  });

  it("shows waiting work without inventing an elapsed time or fetching an arbitrary file", () => {
    render(
      <TestUiProviders>
        <ChatPreviewContext.Provider value={{
          scope: { scope_type: "private", scope_id: "7" },
          capabilityActions: null,
          browserDrawerOpen: false,
          computerDrawerOpen: false,
          computerMode: null,
          computerSurface: { ...surface, mode: null, file: null },
          openComputer: vi.fn(),
          openBrowserAssist: vi.fn(),
        }}
        >
          <ComputerPip />
        </ChatPreviewContext.Provider>
      </TestUiProviders>,
    );

    expect(screen.getByRole("button", { name: "Show the AI computer" })).toBeVisible();
    expect(screen.getByText("Waiting for a work preview")).toBeVisible();
    expect(screen.queryByText(/^Elapsed /)).not.toBeInTheDocument();
    expect(fetchPreviewFile).not.toHaveBeenCalled();
  });

  it("stays hidden when the computer surface is idle", () => {
    render(
      <TestUiProviders>
        <ChatPreviewContext.Provider value={{
          scope: { scope_type: "private", scope_id: "7" },
          capabilityActions: null,
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
      </TestUiProviders>,
    );
    expect(screen.queryByRole("button", { name: "Show the AI computer" })).not.toBeInTheDocument();
  });

  it("opens the read-only computer and does not take control", async () => {
    const openComputer = vi.fn();
    const openBrowserAssist = vi.fn();
    const user = userEvent.setup();
    render(
      <TestUiProviders>
        <ChatPreviewContext.Provider value={{
          scope: { scope_type: "private", scope_id: "7" },
          capabilityActions: null,
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
      </TestUiProviders>,
    );
    const button = screen.getByRole("button", { name: "Show the AI computer" });
    expect(button).toBeVisible();
    button.focus();
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(openComputer).toHaveBeenCalledTimes(1);
    expect(openComputer).toHaveBeenCalledWith(undefined, button);
    await user.click(button);
    expect(openComputer).toHaveBeenCalledTimes(2);
    expect(openBrowserAssist).not.toHaveBeenCalled();
  });

  it("unmounts when the computer is expanded", () => {
    render(
      <TestUiProviders>
        <ChatPreviewContext.Provider value={{
          scope: { scope_type: "private", scope_id: "7" },
          capabilityActions: null,
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
      </TestUiProviders>,
    );
    expect(screen.queryByRole("button", { name: "Show the AI computer" })).not.toBeInTheDocument();
  });

  it("shows the real file snapshot in its compact viewport", async () => {
    render(
      <TestUiProviders>
        <ChatPreviewContext.Provider value={{
          scope: { scope_type: "private", scope_id: "7" },
          capabilityActions: null,
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
      </TestUiProviders>,
    );

    expect(await screen.findByText("const answer = 42;")).toBeVisible();
  });

  it("never shows the previous Run's late draft after the pip switches to a new Run", async () => {
    const pending: Array<{ resolve: (value: AgentPreviewFileResponse) => void }> = [];
    vi.mocked(fetchPreviewFile).mockImplementation(() => new Promise((resolve) => {
      pending.push({ resolve });
    }));
    const pipFor = (runId: string, draftRevision: number) => (
      <TestUiProviders>
        <ChatPreviewContext.Provider value={{
          scope: { scope_type: "private", scope_id: "7" },
          capabilityActions: null,
          browserDrawerOpen: false,
          computerDrawerOpen: false,
          computerMode: "file",
          computerSurface: {
            ...surface,
            runId,
            file: {
              tool: "write_file",
              path: "draft.txt",
              workspace_path: "draft.txt",
              target: "sandbox",
              source: "draft",
              draft_kind: "file",
              status: "running",
              tool_call_id: "call",
              revision: `draft:call:${draftRevision}`,
            },
          },
          openComputer: vi.fn(),
          openBrowserAssist: vi.fn(),
        }}
        >
          <ComputerPip />
        </ChatPreviewContext.Provider>
      </TestUiProviders>
    );
    const draft = (content: string, draftRevision: number): AgentPreviewFileResponse => ({
      workspace_path: "draft.txt",
      content,
      truncated: false,
      encoding: "utf-8",
      source: "draft",
      draft_kind: "file",
      revision: `draft:call:${draftRevision}`,
    });

    const rendered = render(pipFor("run-A", 9));
    await waitFor(() => expect(pending).toHaveLength(1));

    rendered.rerender(pipFor("run-B", 1));
    await act(async () => {
      pending[0].resolve(draft("A_STALE_DRAFT", 9));
      await Promise.resolve();
    });
    expect(screen.queryByText("A_STALE_DRAFT")).not.toBeInTheDocument();

    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => {
      pending[1].resolve(draft("B_CURRENT_DRAFT", 1));
      await Promise.resolve();
    });
    expect(await screen.findByText("B_CURRENT_DRAFT")).toBeVisible();
    expect(screen.queryByText("A_STALE_DRAFT")).not.toBeInTheDocument();
  });

  it("shows bounded search hits instead of a generic computer icon", () => {
    render(
      <TestUiProviders>
        <ChatPreviewContext.Provider value={{
          scope: { scope_type: "channel", scope_id: "9" },
          capabilityActions: null,
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
      </TestUiProviders>,
    );

    expect(screen.getByText("Platform architecture")).toBeInTheDocument();
  });

  it("shows a completed presented page inside the compact viewport", () => {
    render(
      <TestUiProviders>
        <ChatPreviewContext.Provider value={{
          scope: { scope_type: "private", scope_id: "7" },
          capabilityActions: null,
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
      </TestUiProviders>,
    );

    const frame = screen.getByTitle("Presented page");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
  });

  it("uses the surface step as the compact terminal fallback", () => {
    render(
      <TestUiProviders>
        <ChatPreviewContext.Provider value={{
          scope: { scope_type: "private", scope_id: "7" },
          capabilityActions: null,
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
      </TestUiProviders>,
    );

    expect(screen.getByLabelText("Read-only terminal output"))
      .toHaveTextContent("$ printf ready");
    expect(screen.getByLabelText("Read-only terminal output"))
      .toHaveTextContent("ready");
  });
});
