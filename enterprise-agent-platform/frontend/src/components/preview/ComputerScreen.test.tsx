// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPreviewFile } from "../../data/previewActions";
import { LOCALE_STORAGE_KEY } from "../../i18n";
import { StoreProvider } from "../../store/StoreProvider";
import { TestUiProviders } from "../../test/TestUiProviders";
import type { AgentPreviewFileResponse } from "../../types";
import type { ComputerSurface } from "./computer";
import { ComputerScreen } from "./ComputerScreen";

vi.mock("../../data/previewActions", async () => {
  const actual = await vi.importActual<typeof import("../../data/previewActions")>(
    "../../data/previewActions",
  );
  return { ...actual, fetchPreviewFile: vi.fn() };
});

const scope = { scope_type: "private" as const, scope_id: "7" };
const defaultMatchMedia = window.matchMedia;

/** The same tool call identity and path across two Runs. */
function runningDraftSurface(runId: string): ComputerSurface {
  return {
    visible: true,
    live: true,
    runId,
    startedAt: null,
    mode: "file",
    file: {
      tool: "write_file",
      path: "draft.txt",
      workspace_path: "draft.txt",
      target: "sandbox",
      source: "draft",
      draft_kind: "file",
      status: "running",
      tool_call_id: "call",
      done: false,
    },
    searchHits: [],
    searchTool: "",
    present: null,
  };
}

function draft(content: string): AgentPreviewFileResponse {
  return {
    workspace_path: "draft.txt",
    content,
    truncated: false,
    encoding: "utf-8",
    source: "draft",
    draft_kind: "file",
  };
}

function screenFor(surface: ComputerSurface) {
  return (
    <StoreProvider><TestUiProviders>
      <ComputerScreen
        scope={scope}
        surface={surface}
        availabilityError=""
        onRetryAvailability={() => undefined}
      />
    </TestUiProviders></StoreProvider>
  );
}

describe("ComputerScreen", () => {
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
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.useRealTimers();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: defaultMatchMedia,
    });
  });

  it("shows waiting work until real content arrives without reading a fallback file", () => {
    const waiting: ComputerSurface = {
      ...runningDraftSurface("run-waiting"),
      mode: null,
      file: null,
    };
    const view = render(screenFor(waiting));

    expect(screen.getByText("Waiting for a work preview")).toBeVisible();
    expect(screen.queryByText(/^Elapsed /)).not.toBeInTheDocument();
    expect(fetchPreviewFile).not.toHaveBeenCalled();

    view.rerender(screenFor({
      ...waiting,
      mode: "search",
      searchTool: "web",
      searchHits: [{ title: "<img src=x onerror=alert(1)>", snippet: "Authoritative search result" }],
    }));

    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeVisible();
    expect(screen.getByText("Authoritative search result")).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByText("Waiting for a work preview")).not.toBeInTheDocument();
    expect(fetchPreviewFile).not.toHaveBeenCalled();
  });

  it("uses the Run start while expanded and stops timing a retained page after the Run ends", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T12:00:05.000Z"));
    const working: ComputerSurface = {
      ...runningDraftSurface("run-clock"),
      startedAt: Date.parse("2026-08-15T12:00:00.000Z") / 1_000,
      mode: null,
      file: null,
    };
    const view = render(screenFor(working));
    expect(screen.getByText("Elapsed 00:05")).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText("Elapsed 00:06")).toBeVisible();

    view.rerender(screenFor({
      ...working,
      live: false,
      mode: "present",
      present: { workspace_path: "page.html", status: "completed" },
    }));
    expect(screen.getByTitle("Presented page")).toBeInTheDocument();
    expect(screen.queryByText(/^Elapsed /)).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.queryByText(/^Elapsed /)).not.toBeInTheDocument();
  });

  it("never shows the previous Run's late draft once the surface belongs to a new Run", async () => {
    const pending: Array<{ resolve: (value: AgentPreviewFileResponse) => void }> = [];
    vi.mocked(fetchPreviewFile).mockImplementation(() => new Promise((resolve) => {
      pending.push({ resolve });
    }));

    const rendered = render(screenFor(runningDraftSurface("run-A")));
    await waitFor(() => expect(pending).toHaveLength(1));

    // Run B reuses the tool call identity and path.
    rendered.rerender(screenFor(runningDraftSurface("run-B")));
    await act(async () => {
      pending[0].resolve(draft("A_STALE_DRAFT"));
      await Promise.resolve();
    });

    expect(screen.queryByText("A_STALE_DRAFT")).not.toBeInTheDocument();
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => {
      pending[1].resolve(draft("B_CURRENT_DRAFT"));
      await Promise.resolve();
    });

    expect(await screen.findByText("B_CURRENT_DRAFT")).toBeVisible();
    expect(screen.queryByText("A_STALE_DRAFT")).not.toBeInTheDocument();
  });

});
