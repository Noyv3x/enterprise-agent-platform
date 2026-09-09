// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPreviewFile } from "../../data/previewActions";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { ApiError } from "../../lib/api";
import type { AgentPreviewFileResponse, ComputerFileClue } from "../../types";
import { FileComputerView } from "./FileComputerView";

vi.mock("../../data/previewActions", () => ({
  fetchPreviewFile: vi.fn(),
}));

const scope = { scope_type: "private" as const, scope_id: "7" };
const defaultMatchMedia = window.matchMedia;

function view(file: ComputerFileClue) {
  return (
    <I18nProvider>
      <FileComputerView scope={scope} runId="run-1" file={file} />
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
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: defaultMatchMedia,
    });
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
        source: "workspace",
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
    expect(screen.getByText("Loading file…").closest("[aria-busy]")).toHaveAttribute("aria-busy", "true");
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
    expect(screen.getByText("Loading file…").closest("[aria-busy]")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("refreshes a completed same-path patch and marks the real changed line", async () => {
    vi.mocked(fetchPreviewFile)
      .mockResolvedValueOnce({
        workspace_path: "src/value.ts",
        content: "const value = 1;",
        truncated: false,
        encoding: "utf-8",
        source: "workspace",
      })
      .mockResolvedValueOnce({
        workspace_path: "src/value.ts",
        content: "const value = 2;",
        truncated: false,
        encoding: "utf-8",
        source: "workspace",
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

    expect(await screen.findByText("const value = 2;")).toBeVisible();
    expect(screen.queryByText("const value = 1;")).not.toBeInTheDocument();
    expect(fetchPreviewFile).toHaveBeenCalledTimes(2);
  });

  it("keeps successive file drafts labeled as uncommitted before settling on the workspace", async () => {
    vi.mocked(fetchPreviewFile)
      .mockResolvedValueOnce({
        workspace_path: "src/draft.ts",
        content: "export const value = 1;",
        truncated: false,
        encoding: "utf-8",
        source: "draft",
        draft_kind: "file",
        revision: "draft:write-draft:1",
      })
      .mockResolvedValueOnce({
        workspace_path: "src/draft.ts",
        content: "export const value = 12;",
        truncated: false,
        encoding: "utf-8",
        source: "draft",
        draft_kind: "file",
        revision: "draft:write-draft:2",
      })
      .mockResolvedValueOnce({
        workspace_path: "src/draft.ts",
        content: "export const value = 12;",
        truncated: false,
        encoding: "utf-8",
        source: "workspace",
      });

    const running: ComputerFileClue = {
      tool: "write_file",
      path: "src/draft.ts",
      workspace_path: "src/draft.ts",
      target: "sandbox",
      status: "running",
      tool_call_id: "write-draft",
      revision: "draft:write-draft:1",
    };
    const rendered = render(view(running));

    expect(await screen.findByText("Uncommitted file draft")).toBeVisible();
    expect(screen.getByText("export const value = 1;")).toBeVisible();

    rendered.rerender(view({ ...running, revision: "draft:write-draft:2" }));
    expect(await screen.findByText("export const value = 12;")).toBeVisible();
    expect(screen.getByText("Uncommitted file draft")).toBeVisible();
    expect(fetchPreviewFile).toHaveBeenCalledTimes(2);

    rendered.rerender(view({
      ...running,
      status: "completed",
      updated_sequence: 3,
      revision: "write-draft:3:completed",
    }));
    await waitFor(() => {
      expect(fetchPreviewFile).toHaveBeenCalledTimes(3);
      expect(screen.queryByText("Uncommitted file draft")).not.toBeInTheDocument();
    });
  });

  it("identifies a patch draft as an uncommitted replacement fragment", async () => {
    vi.mocked(fetchPreviewFile).mockResolvedValueOnce({
      workspace_path: "src/value.ts",
      content: "const value = nextValue;",
      truncated: false,
      encoding: "utf-8",
      source: "draft",
      draft_kind: "replacement",
      revision: "draft:patch-draft:4",
    });

    render(view({
      tool: "patch_file",
      path: "src/value.ts",
      workspace_path: "src/value.ts",
      target: "sandbox",
      status: "running",
      tool_call_id: "patch-draft",
      revision: "draft:patch-draft:4",
    }));

    expect(await screen.findByText("Uncommitted replacement draft")).toBeVisible();
  });

  it("keeps one read in flight, coalesces revision bursts, and fences the superseded response", async () => {
    let resolveOld: ((value: Awaited<ReturnType<typeof fetchPreviewFile>>) => void) | undefined;
    vi.mocked(fetchPreviewFile)
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveOld = resolve;
      }))
      .mockResolvedValueOnce({
        workspace_path: "src/race.ts",
        content: "committed workspace",
        truncated: false,
        encoding: "utf-8",
        source: "workspace",
      });

    const first: ComputerFileClue = {
      tool: "write_file",
      path: "src/race.ts",
      workspace_path: "src/race.ts",
      target: "sandbox",
      status: "running",
      tool_call_id: "race",
      revision: "draft:race:1",
    };
    const rendered = render(view(first));
    await waitFor(() => expect(fetchPreviewFile).toHaveBeenCalledTimes(1));
    const firstSignal = vi.mocked(fetchPreviewFile).mock.calls[0]?.[2];
    rendered.rerender(view({
      ...first,
      updated_sequence: 2,
      revision: "draft:race:2",
    }));
    rendered.rerender(view({
      ...first,
      status: "completed",
      updated_sequence: 3,
      revision: "race:3:completed",
    }));

    await act(async () => Promise.resolve());
    expect(fetchPreviewFile).toHaveBeenCalledTimes(1);
    expect(firstSignal?.aborted).toBe(false);

    await act(async () => {
      resolveOld?.({
        workspace_path: "src/race.ts",
        content: "older draft",
        truncated: false,
        encoding: "utf-8",
        source: "draft",
        draft_kind: "file",
        revision: "draft:race:1",
      });
      await Promise.resolve();
    });

    expect(await screen.findByText("committed workspace")).toBeVisible();
    expect(fetchPreviewFile).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("older draft")).not.toBeInTheDocument();
    expect(screen.queryByText("Uncommitted file draft")).not.toBeInTheDocument();
  });

  it("reveals each monotonic draft revision while the stream keeps outrunning the read", async () => {
    const reads: Array<{ announced: number; resolve: (value: AgentPreviewFileResponse) => void }> = [];
    let announced = 1;
    vi.mocked(fetchPreviewFile).mockImplementation(() => new Promise((resolve) => {
      reads.push({ announced, resolve });
    }));
    const streaming = (revision: number): ComputerFileClue => ({
      tool: "write_file",
      path: "draft.txt",
      workspace_path: "draft.txt",
      target: "sandbox",
      status: "running",
      tool_call_id: "write-stream",
      revision: `draft:write-stream:${revision}`,
    });
    const rendered = render(view(streaming(announced)));
    await waitFor(() => expect(reads).toHaveLength(1));

    for (let step = 0; step < 3; step += 1) {
      // Three newer revisions are announced before the in-flight read answers.
      for (let burst = 0; burst < 3; burst += 1) {
        announced += 1;
        rendered.rerender(view(streaming(announced)));
      }
      const read = reads[reads.length - 1];
      expect(reads).toHaveLength(step + 1);
      await act(async () => {
        read.resolve({
          workspace_path: "draft.txt",
          content: `DRAFT_${read.announced}`,
          truncated: false,
          encoding: "utf-8",
          source: "draft",
          draft_kind: "file",
          revision: `draft:write-stream:${read.announced}`,
        });
        await Promise.resolve();
      });
      // The older-but-monotonic answer is shown at once while a single new read
      // chases the newest announced revision.
      expect(await screen.findByText(`DRAFT_${read.announced}`)).toBeVisible();
      expect(screen.getByText("Uncommitted file draft")).toBeVisible();
      await waitFor(() => expect(reads).toHaveLength(step + 2));
    }

    expect(reads.map((read) => read.announced)).toEqual([1, 4, 7, 10]);
    rendered.unmount();
  });

  it("aborts reads when the scope path changes or the consumer unmounts", async () => {
    vi.mocked(fetchPreviewFile).mockImplementation(() => new Promise(() => {}));
    const first: ComputerFileClue = {
      tool: "read_file",
      path: "first.txt",
      workspace_path: "first.txt",
      target: "sandbox",
      status: "completed",
      revision: "first:1:completed",
    };
    const rendered = render(view(first));
    await waitFor(() => expect(fetchPreviewFile).toHaveBeenCalledTimes(1));
    const firstSignal = vi.mocked(fetchPreviewFile).mock.calls[0]?.[2];

    rendered.rerender(view({
      ...first,
      path: "second.txt",
      workspace_path: "second.txt",
      revision: "second:1:completed",
    }));
    await waitFor(() => expect(fetchPreviewFile).toHaveBeenCalledTimes(2));
    const secondSignal = vi.mocked(fetchPreviewFile).mock.calls[1]?.[2];
    expect(firstSignal?.aborted).toBe(true);

    rendered.unmount();
    expect(secondSignal?.aborted).toBe(true);
  });

  it("does not duplicate the initial file read under StrictMode effect replay", async () => {
    vi.mocked(fetchPreviewFile).mockResolvedValueOnce({
      workspace_path: "strict.txt",
      content: "strict mode snapshot",
      truncated: false,
      encoding: "utf-8",
      source: "workspace",
    });
    render(
      <StrictMode>
        {view({
          tool: "read_file",
          path: "strict.txt",
          workspace_path: "strict.txt",
          target: "sandbox",
          status: "completed",
          revision: "strict:1:completed",
        })}
      </StrictMode>,
    );

    expect(await screen.findByText("strict mode snapshot")).toBeVisible();
    expect(fetchPreviewFile).toHaveBeenCalledTimes(1);
  });

  it("reveals a large running draft in bounded single-text-node steps", async () => {
    vi.useFakeTimers();
    const content = "a".repeat(14_000);
    const appended = `${content}${"b".repeat(2_048)}`;
    vi.mocked(fetchPreviewFile)
      .mockResolvedValueOnce({
        workspace_path: "src/stream.txt",
        content,
        truncated: false,
        encoding: "utf-8",
        source: "draft",
        draft_kind: "file",
        revision: "draft:stream:1",
      })
      .mockResolvedValueOnce({
        workspace_path: "src/stream.txt",
        content: appended,
        truncated: false,
        encoding: "utf-8",
        source: "draft",
        draft_kind: "file",
        revision: "draft:stream:2",
      });

    const file: ComputerFileClue = {
      tool: "write_file",
      path: "src/stream.txt",
      workspace_path: "src/stream.txt",
      target: "sandbox",
      status: "running",
      tool_call_id: "stream",
      revision: "draft:stream:1",
    };
    const rendered = render(view(file));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const stream = rendered.container.querySelector("pre code");
    expect(stream).not.toBeNull();
    expect(stream?.textContent?.length).toBeGreaterThan(0);
    expect(stream?.textContent?.length).toBeLessThan(content.length);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(stream?.textContent).toBe(content);

    rendered.rerender(view({ ...file, revision: "draft:stream:2" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const firstAppendStep = stream?.textContent?.length || 0;
    expect(firstAppendStep).toBeGreaterThan(content.length);
    expect(firstAppendStep).toBeLessThan(appended.length);
    expect(firstAppendStep - content.length).toBeLessThan(256);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(stream?.textContent).toBe(appended);
  });

  it("continues an append-only draft smoothly into the completed workspace snapshot", async () => {
    vi.useFakeTimers();
    const draft = "draft-content-".repeat(800);
    const workspace = `${draft}${"final-tail-".repeat(120)}`;
    vi.mocked(fetchPreviewFile)
      .mockResolvedValueOnce({
        workspace_path: "src/settle.txt",
        content: draft,
        truncated: false,
        encoding: "utf-8",
        source: "draft",
        draft_kind: "file",
        revision: "draft:settle:1",
      })
      .mockResolvedValueOnce({
        workspace_path: "src/settle.txt",
        content: workspace,
        truncated: false,
        encoding: "utf-8",
        source: "workspace",
      });

    const file: ComputerFileClue = {
      tool: "write_file",
      path: "src/settle.txt",
      workspace_path: "src/settle.txt",
      target: "sandbox",
      status: "running",
      tool_call_id: "settle",
      revision: "draft:settle:1",
    };
    const rendered = render(view(file));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const stream = rendered.container.querySelector("pre code");
    expect(stream?.textContent?.length).toBeLessThan(draft.length);

    rendered.rerender(view({
      ...file,
      status: "completed",
      revision: "settle:2:completed",
    }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(stream?.textContent?.length).toBeLessThan(workspace.length);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(stream?.textContent).toBe(workspace);
    expect(screen.queryByText("Uncommitted file draft")).not.toBeInTheDocument();
  });

  it("immediately replaces a non-prefix draft and cancels queued stale text", async () => {
    vi.useFakeTimers();
    const firstContent = "old-authority-".repeat(500);
    const replacement = "[redacted] replacement authority";
    vi.mocked(fetchPreviewFile)
      .mockResolvedValueOnce({
        workspace_path: "src/rewrite.txt",
        content: firstContent,
        truncated: false,
        encoding: "utf-8",
        source: "draft",
        draft_kind: "file",
        revision: "draft:rewrite:1",
      })
      .mockResolvedValueOnce({
        workspace_path: "src/rewrite.txt",
        content: replacement,
        truncated: false,
        encoding: "utf-8",
        source: "draft",
        draft_kind: "file",
        revision: "draft:rewrite:2",
      });

    const file: ComputerFileClue = {
      tool: "write_file",
      path: "src/rewrite.txt",
      workspace_path: "src/rewrite.txt",
      target: "sandbox",
      status: "running",
      tool_call_id: "rewrite",
      revision: "draft:rewrite:1",
    };
    const rendered = render(view(file));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const stream = rendered.container.querySelector("pre code");
    expect(stream?.textContent).not.toBe(firstContent);

    rendered.rerender(view({ ...file, revision: "draft:rewrite:2" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(stream?.textContent).toBe(replacement);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(stream?.textContent).toBe(replacement);
    expect(stream?.textContent).not.toContain("old-authority-");
  });

  it("shows the authoritative running draft immediately when reduced motion is requested", async () => {
    const content = "reduced motion content ".repeat(400);
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
    vi.mocked(fetchPreviewFile).mockResolvedValueOnce({
      workspace_path: "src/reduced.txt",
      content,
      truncated: false,
      encoding: "utf-8",
      source: "draft",
      draft_kind: "file",
      revision: "draft:reduced:1",
    });

    const rendered = render(view({
      tool: "write_file",
      path: "src/reduced.txt",
      workspace_path: "src/reduced.txt",
      target: "sandbox",
      status: "running",
      tool_call_id: "reduced",
      revision: "draft:reduced:1",
    }));

    await waitFor(() => {
      expect(rendered.container.querySelector("pre code")?.textContent)
        .toBe(content);
    });
  });

});
