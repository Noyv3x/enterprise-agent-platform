// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPreviewFile } from "../../data/previewActions";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
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

/** The same tool call identity across two Runs; only the Run and the draft revision differ. */
function runningDraftSurface(runId: string, draftRevision: number): ComputerSurface {
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
      status: "running",
      tool_call_id: "call",
      revision: `draft:call:${draftRevision}`,
    },
    searchHits: [],
    searchTool: "",
    present: null,
  };
}

function draft(content: string, draftRevision: number): AgentPreviewFileResponse {
  return {
    workspace_path: "draft.txt",
    content,
    truncated: false,
    encoding: "utf-8",
    source: "draft",
    draft_kind: "file",
    revision: `draft:call:${draftRevision}`,
  };
}

function screenFor(surface: ComputerSurface) {
  return (
    <I18nProvider>
      <ComputerScreen
        scope={scope}
        surface={surface}
        availabilityError=""
        onRetryAvailability={() => undefined}
      />
    </I18nProvider>
  );
}

describe("ComputerScreen file drafts across Runs", () => {
  beforeEach(() => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    vi.mocked(fetchPreviewFile).mockReset();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("never shows the previous Run's late draft once the surface belongs to a new Run", async () => {
    const pending: Array<{ resolve: (value: AgentPreviewFileResponse) => void }> = [];
    vi.mocked(fetchPreviewFile).mockImplementation(() => new Promise((resolve) => {
      pending.push({ resolve });
    }));

    const rendered = render(screenFor(runningDraftSurface("run-A", 9)));
    await waitFor(() => expect(pending).toHaveLength(1));

    // Run B reuses the tool call identity and path; its own draft numbering restarts.
    rendered.rerender(screenFor(runningDraftSurface("run-B", 1)));
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
    expect(rendered.container.querySelector(".computer-file")).toHaveAttribute("data-revision", "draft:call:1");
  });

  it("replaces a displayed high-revision draft of the previous Run with the new Run's low revisions while they keep being superseded", async () => {
    const pending: Array<{ resolve: (value: AgentPreviewFileResponse) => void }> = [];
    vi.mocked(fetchPreviewFile).mockImplementation(() => new Promise((resolve) => {
      pending.push({ resolve });
    }));

    const rendered = render(screenFor(runningDraftSurface("run-A", 100)));
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending[0].resolve(draft("A_DRAFT_100", 100));
      await Promise.resolve();
    });
    expect(await screen.findByText("A_DRAFT_100")).toBeVisible();

    // Run B reuses the tool call identity and path with a restarted numbering that
    // stays far below the previous Run's displayed revision.
    rendered.rerender(screenFor(runningDraftSurface("run-B", 1)));
    await waitFor(() => expect(pending).toHaveLength(2));

    for (let revision = 1; revision <= 3; revision += 1) {
      // B announces its next revision before the in-flight read answers, so every
      // B response arrives already superseded within its own lineage.
      rendered.rerender(screenFor(runningDraftSurface("run-B", revision + 1)));
      const read = pending[pending.length - 1];
      expect(pending).toHaveLength(revision + 1);
      await act(async () => {
        read.resolve(draft(`B_DRAFT_${revision}`, revision));
        await Promise.resolve();
      });
      // The displayed revision belongs to Run A; B's first draft is a new lineage,
      // not an older revision of the same one, and must appear at once.
      expect(await screen.findByText(`B_DRAFT_${revision}`)).toBeVisible();
      expect(screen.queryByText("A_DRAFT_100")).not.toBeInTheDocument();
      await waitFor(() => expect(pending).toHaveLength(revision + 2));
    }

    expect(rendered.container.querySelector(".computer-file")).toHaveAttribute("data-revision", "draft:call:3");
  });
});
