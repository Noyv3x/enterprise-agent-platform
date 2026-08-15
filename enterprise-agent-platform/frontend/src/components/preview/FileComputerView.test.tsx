// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPreviewFile } from "../../data/previewActions";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { ApiError } from "../../lib/api";
import type { ComputerFileClue } from "../../types";
import { FileComputerView } from "./FileComputerView";

vi.mock("../../data/previewActions", () => ({
  fetchPreviewFile: vi.fn(),
}));

const scope = { scope_type: "private" as const, scope_id: "7" };

function view(file: ComputerFileClue) {
  return (
    <I18nProvider>
      <FileComputerView scope={scope} file={file} />
    </I18nProvider>
  );
}

describe("FileComputerView", () => {
  beforeEach(() => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    vi.mocked(fetchPreviewFile).mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    localStorage.clear();
  });

  it("keeps a started 404 pending and fetches the same path again when creation completes", async () => {
    let rejectStarted: ((reason?: unknown) => void) | undefined;
    vi.mocked(fetchPreviewFile)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectStarted = reject;
      }))
      .mockResolvedValueOnce({
        workspace_path: "notes.md",
        content: "# Created\n\nFinal contents",
        truncated: false,
        encoding: "utf-8",
      });

    const started: ComputerFileClue = {
      tool: "write_file",
      path: "notes.md",
      workspace_path: "notes.md",
      target: "sandbox",
      status: "running",
      tool_call_id: "write-1",
      revision: "write-1:1:running",
    };
    const rendered = render(view(started));
    await waitFor(() => expect(fetchPreviewFile).toHaveBeenCalledTimes(1));

    await act(async () => {
      rejectStarted?.(new ApiError("not found", 404));
      await Promise.resolve();
    });
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    rendered.rerender(view({
      ...started,
      status: "completed",
      updated_sequence: 2,
      revision: "write-1:2:completed",
    }));

    expect(await screen.findByText("Final contents")).toBeVisible();
    expect(fetchPreviewFile).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetchPreviewFile).mock.calls[1]?.[1]).toBe("notes.md");
  });

  it("bounds automatic retries while a running atomic write remains unavailable", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchPreviewFile).mockRejectedValue(new ApiError("not found", 404));

    render(view({
      tool: "write_file",
      path: "slow.md",
      workspace_path: "slow.md",
      target: "sandbox",
      status: "running",
      tool_call_id: "write-slow",
      revision: "write-slow:1:running",
    }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchPreviewFile).toHaveBeenCalledTimes(9);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchPreviewFile).toHaveBeenCalledTimes(9);
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("refreshes a completed same-path patch and marks the real changed line", async () => {
    vi.mocked(fetchPreviewFile)
      .mockResolvedValueOnce({
        workspace_path: "src/value.ts",
        content: "const value = 1;",
        truncated: false,
        encoding: "utf-8",
      })
      .mockResolvedValueOnce({
        workspace_path: "src/value.ts",
        content: "const value = 2;",
        truncated: false,
        encoding: "utf-8",
      });

    const initial: ComputerFileClue = {
      tool: "write_file",
      path: "src/value.ts",
      workspace_path: "src/value.ts",
      target: "sandbox",
      status: "completed",
      tool_call_id: "write-2",
      revision: "write-2:3:completed",
    };
    const rendered = render(view(initial));
    expect(await screen.findByText("const value = 1;")).toBeVisible();

    rendered.rerender(view({
      ...initial,
      tool: "patch_file",
      tool_call_id: "patch-3",
      updated_sequence: 7,
      revision: "patch-3:7:completed",
    }));

    const changed = await screen.findByText("const value = 2;");
    expect(changed).toHaveClass("computer-file__line", "is-changed");
    expect(screen.queryByText("const value = 1;")).not.toBeInTheDocument();
    expect(fetchPreviewFile).toHaveBeenCalledTimes(2);
  });

  it("renders a large snapshot as one complete text node without thousands of animated spans", async () => {
    const largeContent = Array.from({ length: 241 }, (_value, index) => `line ${index}`).join("\n");
    vi.mocked(fetchPreviewFile).mockResolvedValueOnce({
      workspace_path: "large.log",
      content: largeContent,
      truncated: false,
      encoding: "utf-8",
    });

    const rendered = render(view({
      tool: "read_file",
      path: "large.log",
      workspace_path: "large.log",
      target: "sandbox",
      status: "completed",
      revision: "read-4:9:completed",
    }));

    await waitFor(() => {
      expect(rendered.container.querySelector('[data-render-mode="plain"]')).not.toBeNull();
    });
    const code = rendered.container.querySelector('[data-render-mode="plain"] code');
    expect(code?.textContent).toBe(largeContent);
    expect(rendered.container.querySelectorAll(".computer-file__line")).toHaveLength(0);
  });
});
