// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPreviewFile } from "../../data/previewActions";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
import type { AgentPreviewFileResponse, AgentPreviewScope, ComputerFileClue } from "../../types";
import { FileComputerView } from "./FileComputerView";

vi.mock("../../data/previewActions", () => ({ fetchPreviewFile: vi.fn() }));
const scope: AgentPreviewScope = { scope_type: "private", scope_id: "7" };
const file: ComputerFileClue = { tool: "write_file", workspace_path: "notes.md", tool_call_id: "call", source: "draft", done: false };
function draft(content: string): AgentPreviewFileResponse {
  return { workspace_path: "notes.md", content, source: "draft", draft_kind: "file", truncated: false };
}

describe("FileComputerView latest snapshots", () => {
  let store = createStore(rootReducer, initialAppState);
  function view(clue = file, selectedScope = scope, runId = "run") {
    return <StoreContext.Provider value={store}><I18nProvider><FileComputerView scope={selectedScope} runId={runId} file={clue} /></I18nProvider></StoreContext.Provider>;
  }
  beforeEach(() => {
    store = createStore(rootReducer, initialAppState);
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    vi.mocked(fetchPreviewFile).mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); });

  it("shows latest snapshots even when reads are slower than the stream, then reads committed content once", async () => {
    const pending: Array<(value: AgentPreviewFileResponse) => void> = [];
    vi.mocked(fetchPreviewFile).mockImplementation(() => new Promise(resolve => pending.push(resolve)));
    const rendered = render(view());
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(fetchPreviewFile).toHaveBeenCalledTimes(1);
    await act(async () => { pending[0]!(draft("first")); });
    expect(screen.getByText("first")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    await act(async () => { pending[1]!(draft("latest replacement")); });
    expect(screen.getByText("latest replacement")).toBeVisible();
    expect(screen.queryByText("first")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    const oldSignal = vi.mocked(fetchPreviewFile).mock.calls[2]![2];
    rendered.rerender(view({ ...file, done: true, source: "workspace", status: "completed" }));
    expect(oldSignal.aborted).toBe(true);
    await act(async () => { pending[2]!(draft("late draft")); pending[3]!({ ...draft("committed"), source: "workspace", draft_kind: undefined }); });
    expect(screen.getByText("committed")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(fetchPreviewFile).toHaveBeenCalledTimes(4);
    expect(screen.queryByText("late draft")).not.toBeInTheDocument();
  });

  it.each(["account", "scope", "run", "tool", "path"])("clears visible text and fences late responses on %s change", async change => {
    const pending: Array<(value: AgentPreviewFileResponse) => void> = [];
    vi.mocked(fetchPreviewFile).mockImplementation(() => new Promise(resolve => pending.push(resolve)));
    const rendered = render(view());
    await act(async () => { pending[0]!(draft("private old text")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    const signal = vi.mocked(fetchPreviewFile).mock.calls[1]![2];
    if (change === "account") act(() => store.dispatch({ type: "SET_USER", payload: { id: "second" } as NonNullable<typeof initialAppState.user> }));
    const clue = change === "tool" ? { ...file, tool_call_id: "next" } : change === "path" ? { ...file, workspace_path: "other.md" } : file;
    rendered.rerender(view(clue, change === "scope" ? { ...scope, scope_id: "8" } : scope, change === "run" ? "other" : "run"));
    expect(screen.queryByText("private old text")).not.toBeInTheDocument();
    expect(signal.aborted).toBe(true);
    await act(async () => { pending[1]!(draft("late private text")); });
    expect(screen.queryByText("late private text")).not.toBeInTheDocument();
  });

  it("labels replacement fragments and preserves truncation", async () => {
    vi.mocked(fetchPreviewFile).mockResolvedValue({ ...draft("replacement only"), source: "draft", draft_kind: "replacement", truncated: true });
    render(view({ ...file, tool: "patch_file" }));
    await act(async () => {});
    expect(screen.getByText("replacement only")).toBeVisible();
    expect(document.querySelector("[data-draft-kind='replacement']")).not.toBeNull();
    expect(document.querySelector("[data-source='draft']")).not.toBeNull();
  });

  it("stops on a failed snapshot without automatic retry", async () => {
    vi.mocked(fetchPreviewFile).mockRejectedValue(new Error("unavailable"));
    render(view());
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByText("unavailable")).toBeVisible();
    expect(fetchPreviewFile).toHaveBeenCalledTimes(1);
  });

  it("never presents draft text as a completed workspace file", async () => {
    vi.mocked(fetchPreviewFile).mockResolvedValue(draft("not committed"));
    render(view({ ...file, done: true }));
    await act(async () => {});
    expect(screen.queryByText("not committed")).not.toBeInTheDocument();
    expect(screen.getByText("The file could not be loaded.")).toBeVisible();
  });

  it("does not fetch host file content", async () => {
    render(view({ ...file, target: "host" }));
    await act(async () => {});
    expect(fetchPreviewFile).not.toHaveBeenCalled();
  });
});
