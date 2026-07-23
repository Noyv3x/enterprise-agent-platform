// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALE_STORAGE_KEY } from "../../i18n";
import { TestUiProviders } from "../../test/TestUiProviders";
import type { AgentMemory, AgentMemoryCandidate, AgentMemoryTarget } from "../../types";
import { MemoryPanel } from "./MemoryPanel";

const mocks = vi.hoisted(() => ({
  loadAgentMemories: vi.fn(),
  createAgentMemory: vi.fn(),
  updateAgentMemory: vi.fn(),
  deleteAgentMemory: vi.fn(),
  clearAgentMemories: vi.fn(),
  exportAgentMemories: vi.fn(),
  loadAgentMemoryCandidates: vi.fn(),
  approveAgentMemoryCandidate: vi.fn(),
  rejectAgentMemoryCandidate: vi.fn(),
  downloadJson: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../../data/memoryActions", () => ({
  loadAgentMemories: mocks.loadAgentMemories,
  createAgentMemory: mocks.createAgentMemory,
  updateAgentMemory: mocks.updateAgentMemory,
  deleteAgentMemory: mocks.deleteAgentMemory,
  clearAgentMemories: mocks.clearAgentMemories,
  exportAgentMemories: mocks.exportAgentMemories,
  loadAgentMemoryCandidates: mocks.loadAgentMemoryCandidates,
  approveAgentMemoryCandidate: mocks.approveAgentMemoryCandidate,
  rejectAgentMemoryCandidate: mocks.rejectAgentMemoryCandidate,
}));

vi.mock("../../lib/api", () => ({ downloadJson: mocks.downloadJson }));
vi.mock("../../context/ToastContext", () => ({ toast: mocks.toast }));

const agentMemory: AgentMemory = {
  id: 9,
  target: "memory",
  content: "Run frontend checks before merging.",
  tags: ["workflow"],
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-17T09:00:00Z",
  source_type: "manual",
  blocked: false,
  blocked_reasons: [],
};

const userMemory: AgentMemory = {
  id: 10,
  target: "user",
  content: "Prefers concise Chinese replies.",
  tags: ["preference"],
  created_at: "2026-07-02T00:00:00Z",
  updated_at: "2026-07-17T10:00:00Z",
  source_type: "manual",
  blocked: false,
  blocked_reasons: [],
};

const candidate = (id: number, content: string, target: AgentMemoryTarget = "memory"): AgentMemoryCandidate => ({
  id,
  target,
  content,
  tags: [],
  status: "pending",
  source_message_id: String(id + 100),
  created_at: "2026-07-18T08:00:00Z",
  decided_at: null,
  memory_id: null,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function renderPanel() {
  return render(<TestUiProviders><MemoryPanel /></TestUiProviders>);
}

describe("MemoryPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    mocks.loadAgentMemories.mockImplementation((target: AgentMemoryTarget) => Promise.resolve({
      memories: target === "user" ? [userMemory] : [agentMemory],
    }));
    mocks.loadAgentMemoryCandidates.mockResolvedValue({ candidates: [] });
    mocks.createAgentMemory.mockResolvedValue({
      changed: [{ action: "add", id: agentMemory.id, created: true, duplicate: false }],
    });
    mocks.updateAgentMemory.mockResolvedValue({
      changed: [{ action: "replace", id: agentMemory.id }],
    });
    mocks.deleteAgentMemory.mockResolvedValue({
      changed: [{ action: "remove", id: agentMemory.id }],
    });
    mocks.clearAgentMemories.mockResolvedValue({
      changed: [{ action: "clear", deleted: 1 }],
    });
    mocks.exportAgentMemories.mockResolvedValue({
      version: 1,
      exported_at: "2026-07-18T08:00:00Z",
      memories: [agentMemory, userMemory],
    });
    mocks.approveAgentMemoryCandidate.mockResolvedValue({
      candidate: { ...candidate(1, "Approved"), status: "approved" },
      memory: agentMemory,
      created: true,
    });
    mocks.rejectAgentMemoryCandidate.mockResolvedValue({
      candidate: { ...candidate(2, "Ignored"), status: "rejected" },
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("explains chat clearing, searches the active target, and switches to About me", async () => {
    const user = userEvent.setup();
    renderPanel();

    expect(screen.getByText("Chat history and memory are separate")).toBeVisible();
    expect(screen.getByText(/Clearing chat only hides the conversation/)).toBeVisible();
    expect(await screen.findByText(agentMemory.content)).toBeVisible();
    expect(mocks.loadAgentMemories).toHaveBeenCalledWith("memory", "", expect.any(AbortSignal));
    expect(screen.getByRole("searchbox", { name: "Search this category" })).toHaveAttribute("maxlength", "4000");
    expect(screen.getByRole("textbox", { name: "Add a memory" })).toHaveAttribute("maxlength", "4000");

    await user.type(screen.getByRole("searchbox", { name: "Search this category" }), "frontend");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => {
      expect(mocks.loadAgentMemories).toHaveBeenLastCalledWith("memory", "frontend", expect.any(AbortSignal));
    });

    await user.click(screen.getByRole("tab", { name: "About me" }));
    expect(await screen.findByText(userMemory.content)).toBeVisible();
    expect(mocks.loadAgentMemories).toHaveBeenLastCalledWith("user", "", expect.any(AbortSignal));
  });

  it("adds and edits a memory with the active target", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText(agentMemory.content);

    const addContent = "Use semantic commit subjects.";
    fireEvent.change(screen.getByRole("textbox", { name: "Add a memory" }), { target: { value: addContent } });
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(mocks.createAgentMemory).toHaveBeenCalledWith({
      target: "memory",
      content: addContent,
    });

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("textbox", { name: "Memory content" });
    fireEvent.change(editor, { target: { value: "Run every frontend test before merging." } });
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mocks.updateAgentMemory).toHaveBeenCalledWith(9, {
      target: "memory",
      content: "Run every frontend test before merging.",
      tags: ["workflow"],
    });
  });

  it("keeps the loaded list usable when a mutation fails", async () => {
    const user = userEvent.setup();
    mocks.createAgentMemory.mockRejectedValueOnce(new Error("Memory write failed"));
    renderPanel();
    await screen.findByText(agentMemory.content);

    await user.type(screen.getByRole("textbox", { name: "Add a memory" }), "Will fail");
    await user.click(screen.getByRole("button", { name: "Add" }));

    const writeError = await screen.findByText("Memory write failed");
    expect(writeError.closest('[role="alert"]')).toBeInTheDocument();
    expect(screen.getByText(agentMemory.content)).toBeVisible();
    expect(screen.queryByText("Loading memories")).not.toBeInTheDocument();
  });

  it("refreshes the latest target when a mutation finishes after switching tabs", async () => {
    const user = userEvent.setup();
    const pendingCreate = deferred<{ changed: Array<{ action: string; id: number }> }>();
    mocks.createAgentMemory.mockReturnValueOnce(pendingCreate.promise);
    renderPanel();
    await screen.findByText(agentMemory.content);

    await user.type(screen.getByRole("textbox", { name: "Add a memory" }), "Remember this later.");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(mocks.createAgentMemory).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("tab", { name: "About me" }));
    expect(await screen.findByText(userMemory.content)).toBeVisible();

    await act(async () => {
      pendingCreate.resolve({ changed: [{ action: "add", id: 11 }] });
      await pendingCreate.promise;
    });

    await waitFor(() => {
      const calls = mocks.loadAgentMemories.mock.calls;
      expect(calls[calls.length - 1]?.[0]).toBe("user");
      expect(screen.getByText(userMemory.content)).toBeVisible();
      expect(screen.queryByText(agentMemory.content)).not.toBeInTheDocument();
    });
  });

  it("closes a delete dialog immediately, prevents duplicate submission, and shows failure", async () => {
    const user = userEvent.setup();
    const pendingDelete = deferred<{ changed: Array<{ action: string; id: number }> }>();
    mocks.deleteAgentMemory.mockReturnValueOnce(pendingDelete.promise);
    renderPanel();
    await screen.findByText(agentMemory.content);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: "Delete this memory?" });
    const confirm = within(dialog).getByRole("button", { name: "Delete" });
    act(() => {
      confirm.click();
      confirm.click();
    });

    expect(screen.queryByRole("dialog", { name: "Delete this memory?" })).not.toBeInTheDocument();
    expect(mocks.deleteAgentMemory).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingDelete.reject(new Error("Delete failed"));
      try {
        await pendingDelete.promise;
      } catch {
        // The panel converts the failure into a visible inline error.
      }
    });
    const deleteError = await screen.findByText("Delete failed");
    expect(deleteError.closest('[role="alert"]')).toBeInTheDocument();
  });

  it("confirms delete and target-scoped clear operations", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText(agentMemory.content);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    let dialog = screen.getByRole("dialog", { name: "Delete this memory?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(mocks.deleteAgentMemory).toHaveBeenCalledWith(9);

    await user.click(screen.getByRole("button", { name: "Clear Agent memory" }));
    dialog = screen.getByRole("dialog", { name: "Clear “Agent memory”?" });
    expect(within(dialog).getByText(
      /Every memory in this category will be permanently deleted/,
    )).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Clear Agent memory" }));
    expect(mocks.clearAgentMemories).toHaveBeenCalledWith("memory");
  });

  it("exports both memory targets as a JSON download", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText(agentMemory.content);

    await user.click(screen.getByRole("button", { name: "Export all" }));

    expect(mocks.exportAgentMemories).toHaveBeenCalledTimes(1);
    expect(mocks.downloadJson).toHaveBeenCalledWith(
      expect.objectContaining({ memories: [agentMemory, userMemory] }),
      expect.stringMatching(/^ubitech-agent-memories-\d{4}-\d{2}-\d{2}\.json$/),
    );
  });

  it("approves or ignores pending memory suggestions before they become durable", async () => {
    const user = userEvent.setup();
    const first = candidate(1, "Remember the project test command.");
    const second = candidate(2, "Remember my response preference.", "user");
    mocks.loadAgentMemoryCandidates
      .mockResolvedValueOnce({ candidates: [first, second] })
      .mockResolvedValueOnce({ candidates: [second] })
      .mockResolvedValueOnce({ candidates: [] });
    renderPanel();

    const firstCard = (await screen.findByText(first.content)).closest("article");
    expect(firstCard).not.toBeNull();
    await user.click(within(firstCard!).getByRole("button", { name: "Approve" }));
    expect(mocks.approveAgentMemoryCandidate).toHaveBeenCalledWith(1);
    await waitFor(() => expect(screen.queryByText(first.content)).not.toBeInTheDocument());

    const secondCard = screen.getByText(second.content).closest("article");
    expect(secondCard).not.toBeNull();
    await user.click(within(secondCard!).getByRole("button", { name: "Ignore" }));
    expect(mocks.rejectAgentMemoryCandidate).toHaveBeenCalledWith(2);
    await waitFor(() => expect(screen.queryByText(second.content)).not.toBeInTheDocument());
  });

  it("marks blocked legacy memories and clears hidden unsafe tags on a safe edit", async () => {
    const user = userEvent.setup();
    mocks.loadAgentMemories.mockResolvedValueOnce({
      memories: [{ ...agentMemory, blocked: true, blocked_reasons: ["instruction_override"] }],
    });
    renderPanel();

    expect(await screen.findByText("Excluded from recall")).toBeVisible();
    expect(screen.getByText(/Agent will not read it in conversations/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("textbox", { name: "Memory content" });
    await user.clear(editor);
    await user.type(editor, "Safe replacement memory.");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(mocks.updateAgentMemory).toHaveBeenCalledWith(9, {
      target: "memory",
      content: "Safe replacement memory.",
      tags: [],
    });
  });
});
