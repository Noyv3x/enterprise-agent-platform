// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALE_STORAGE_KEY } from "../../i18n";
import { TestUiProviders } from "../../test/TestUiProviders";
import type { AgentPreviewScope, AgentSkill } from "../../types";
import { SkillsPanel } from "./SkillsPanel";

const mocks = vi.hoisted(() => ({
  loadAgentSkills: vi.fn(),
  loadAgentSkill: vi.fn(),
  createAgentSkill: vi.fn(),
  updateAgentSkill: vi.fn(),
  deleteAgentSkill: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../../data/skillActions", () => ({
  loadAgentSkills: mocks.loadAgentSkills,
  loadAgentSkill: mocks.loadAgentSkill,
  createAgentSkill: mocks.createAgentSkill,
  updateAgentSkill: mocks.updateAgentSkill,
  deleteAgentSkill: mocks.deleteAgentSkill,
}));

vi.mock("../../context/ToastContext", () => ({ toast: mocks.toast }));

const privateScope: AgentPreviewScope = { scope_type: "private", scope_id: "7" };
const channelScope: AgentPreviewScope = { scope_type: "channel", scope_id: "4" };

const reviewSkill: AgentSkill = {
  id: "review-code",
  name: "review-code",
  description: "Review changes with a repeatable quality checklist.",
  instructions: "# Review\n\nRun checks before reporting.",
  category: "development",
  version: "1.0.0",
  tags: ["review", "quality"],
  enabled: true,
  linked_files: ["references/checklist.md", "scripts/check.sh"],
  created_at: "2025-07-09T00:00:00.000000Z",
  updated_at: "2025-07-20T13:46:40.000000Z",
};

const presetSkill: AgentSkill = {
  id: "systematic-debugging",
  name: "systematic-debugging",
  description: "Find root causes before applying fixes.",
  instructions: "# Systematic debugging\n\nReproduce, investigate, fix, and verify.",
  category: "development",
  version: "1.0.0",
  tags: ["debugging"],
  enabled: true,
  linked_files: ["references/NOTICE.md"],
  created_at: null,
  updated_at: null,
  source: "bundled",
  read_only: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function renderPanel(
  scope: AgentPreviewScope = privateScope,
  canManage = true,
) {
  return render(
    <TestUiProviders>
      <SkillsPanel scope={scope} canManage={canManage} />
    </TestUiProviders>,
  );
}

describe("SkillsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    mocks.loadAgentSkills.mockResolvedValue({ skills: [reviewSkill], count: 1 });
    mocks.loadAgentSkill.mockResolvedValue({ skill: reviewSkill });
    mocks.createAgentSkill.mockResolvedValue({ skill: reviewSkill });
    mocks.updateAgentSkill.mockResolvedValue({ skill: reviewSkill });
    mocks.deleteAgentSkill.mockResolvedValue({ deleted: true, id: reviewSkill.id });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("explains progressive loading and searches the exact Agent scope", async () => {
    const user = userEvent.setup();
    renderPanel();

    expect(screen.getByText("Skills load on demand")).toBeVisible();
    expect(screen.getByText(/separate from chat history and memory/)).toBeVisible();
    expect(await screen.findByText(reviewSkill.description)).toBeVisible();
    expect(screen.getByText(/^Updated /)).toBeVisible();
    expect(mocks.loadAgentSkills).toHaveBeenCalledWith(privateScope, "", expect.any(AbortSignal));

    const search = screen.getByRole("searchbox", { name: "Search this Agent's Skills" });
    await user.type(search, "quality review");
    await user.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => {
      expect(mocks.loadAgentSkills).toHaveBeenLastCalledWith(
        privateScope,
        "quality review",
        expect.any(AbortSignal),
      );
    });
  });

  it("creates a Skill from the complete editor and normalizes comma tags", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText(reviewSkill.description);

    await user.click(screen.getByRole("button", { name: "New Skill" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "summarize-research" } });
    fireEvent.change(
      screen.getByRole("textbox", { name: "Description" }),
      { target: { value: "Summarize research with citations." } },
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Category" }), { target: { value: "research" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Version" }), { target: { value: "0.1.0" } });
    fireEvent.change(
      screen.getByRole("textbox", { name: /^Tags/ }),
      { target: { value: "research, citations, research" } },
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: /^Markdown instructions/ }),
      { target: { value: "# Procedure\n\nCollect and verify sources." } },
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mocks.createAgentSkill).toHaveBeenCalledWith(privateScope, {
      name: "summarize-research",
      description: "Summarize research with citations.",
      instructions: "# Procedure\n\nCollect and verify sources.",
      category: "research",
      version: "0.1.0",
      tags: ["research", "citations"],
      enabled: true,
    });
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Create Skill" })).not.toBeInTheDocument();
    });
  });

  it("loads full details only when editing and saves an editable name", async () => {
    const user = userEvent.setup();
    renderPanel(channelScope);
    await screen.findByText(reviewSkill.description);

    expect(mocks.loadAgentSkill).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(mocks.loadAgentSkill).toHaveBeenCalledWith(
      channelScope,
      reviewSkill.id,
      expect.any(AbortSignal),
    );

    const name = await screen.findByRole("textbox", { name: "Name" });
    const editor = screen.getByRole("heading", { name: "Edit Skill" }).closest("form");
    expect(editor).not.toBeNull();
    expect(within(editor!).getByText("2 linked files")).toBeVisible();
    expect(within(editor!).getByText(/reads and maintains linked files on demand/)).toBeVisible();
    await user.clear(name);
    await user.type(name, "review-changes");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mocks.updateAgentSkill).toHaveBeenCalledWith(
      channelScope,
      "review-code",
      expect.objectContaining({
        name: "review-changes",
        instructions: reviewSkill.instructions,
        enabled: true,
      }),
    );
  });

  it("labels bundled Skills as presets and exposes read-only details", async () => {
    const user = userEvent.setup();
    mocks.loadAgentSkills.mockResolvedValueOnce({ skills: [presetSkill], count: 1 });
    mocks.loadAgentSkill.mockResolvedValueOnce({ skill: presetSkill });
    renderPanel();

    expect(await screen.findByRole("heading", { name: presetSkill.name })).toBeVisible();
    expect(screen.getByText("Preset")).toBeVisible();
    expect(screen.queryByRole("switch", { name: `Disable ${presetSkill.name}` })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();

    const viewButton = screen.getByRole("button", { name: `View ${presetSkill.name}` });
    await user.click(viewButton);
    expect(mocks.loadAgentSkill).toHaveBeenCalledWith(
      privateScope,
      presetSkill.id,
      expect.any(AbortSignal),
    );
    const heading = await screen.findByRole("heading", { name: "View Skill" });
    expect(heading).toBeVisible();
    expect(heading).toHaveFocus();
    expect(screen.getByText(/read-only Skill ships with ubitech agent/)).toBeVisible();
    expect(screen.getByText(/reads preset files on demand/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveAttribute("readonly");

    const editor = heading.closest("form");
    expect(editor).not.toBeNull();
    const closeButtons = within(editor!).getAllByRole("button", { name: "Close" });
    await user.click(closeButtons[closeButtons.length - 1]);
    expect(screen.queryByRole("heading", { name: "View Skill" })).not.toBeInTheDocument();
    expect(viewButton).toHaveFocus();
  });

  it("uses detail ownership when a preset is replaced while details load", async () => {
    const user = userEvent.setup();
    mocks.loadAgentSkills.mockResolvedValueOnce({ skills: [presetSkill], count: 1 });
    mocks.loadAgentSkill.mockResolvedValueOnce({ skill: reviewSkill });
    renderPanel();

    await user.click(await screen.findByRole("button", { name: `View ${presetSkill.name}` }));

    expect(await screen.findByRole("heading", { name: "Edit Skill" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Save" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Name" })).not.toHaveAttribute("readonly");
    expect(screen.queryByText(/read-only Skill ships with ubitech agent/)).not.toBeInTheDocument();
  });

  it("discards pending editable details when management permission is revoked", async () => {
    const user = userEvent.setup();
    const pendingDetail = deferred<{ skill: AgentSkill }>();
    let detailSignal: AbortSignal | undefined;
    mocks.loadAgentSkill.mockImplementationOnce((
      _scope: AgentPreviewScope,
      _id: string,
      signal: AbortSignal,
    ) => {
      detailSignal = signal;
      return pendingDetail.promise;
    });
    const view = renderPanel();

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    expect(detailSignal).toBeDefined();
    expect(detailSignal!.aborted).toBe(false);

    view.rerender(
      <TestUiProviders>
        <SkillsPanel scope={privateScope} canManage={false} />
      </TestUiProviders>,
    );
    expect(detailSignal!.aborted).toBe(true);

    await act(async () => {
      pendingDetail.resolve({ skill: reviewSkill });
      await pendingDetail.promise;
    });

    await waitFor(() => {
      expect(screen.queryByText("Loading Skill details")).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("heading", { name: "Edit Skill" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("lets read-only channel viewers inspect a preset without exposing mutations", async () => {
    const user = userEvent.setup();
    mocks.loadAgentSkills.mockResolvedValueOnce({ skills: [presetSkill], count: 1 });
    mocks.loadAgentSkill.mockResolvedValueOnce({ skill: presetSkill });
    renderPanel(channelScope, false);

    await user.click(await screen.findByRole("button", { name: `View ${presetSkill.name}` }));

    expect(await screen.findByRole("heading", { name: "View Skill" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New Skill" })).not.toBeInTheDocument();
  });

  it("toggles availability and prevents a double delete submission", async () => {
    const user = userEvent.setup();
    const pendingDelete = deferred<{ deleted: true; id: string }>();
    mocks.deleteAgentSkill.mockReturnValueOnce(pendingDelete.promise);
    renderPanel();
    await screen.findByText(reviewSkill.description);

    await user.click(screen.getByRole("switch", { name: "Disable review-code" }));
    expect(mocks.updateAgentSkill).toHaveBeenCalledWith(
      privateScope,
      reviewSkill.id,
      { enabled: false },
    );

    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: "Delete “review-code”?" });
    const confirm = within(dialog).getByRole("button", { name: "Delete" });
    act(() => {
      confirm.click();
      confirm.click();
    });

    expect(screen.queryByRole("dialog", { name: "Delete “review-code”?" })).not.toBeInTheDocument();
    expect(mocks.deleteAgentSkill).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingDelete.resolve({ deleted: true, id: reviewSkill.id });
      await pendingDelete.promise;
    });
  });

  it("keeps a failed mutation visible without discarding the loaded list", async () => {
    const user = userEvent.setup();
    mocks.updateAgentSkill.mockRejectedValueOnce(new Error("Skill update failed"));
    renderPanel();
    await screen.findByText(reviewSkill.description);

    await user.click(screen.getByRole("switch", { name: "Disable review-code" }));

    const mutationError = await screen.findByText("Skill update failed");
    expect(mutationError.closest('[role="alert"]')).toBeInTheDocument();
    expect(screen.getByText(reviewSkill.description)).toBeVisible();
  });

  it("keeps channel Skills readable but hides mutations without chat permission", async () => {
    renderPanel(channelScope, false);
    expect(await screen.findByText(reviewSkill.description)).toBeVisible();

    expect(screen.queryByRole("button", { name: "New Skill" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Disable review-code" })).not.toBeInTheDocument();
    expect(mocks.loadAgentSkills).toHaveBeenCalledWith(
      channelScope,
      "",
      expect.any(AbortSignal),
    );
  });

  it("discards a late list response after the active Agent scope changes", async () => {
    const privateLoad = deferred<{ skills: AgentSkill[]; count: number }>();
    mocks.loadAgentSkills.mockImplementation((scope: AgentPreviewScope) => (
      scope.scope_type === "private"
        ? privateLoad.promise
        : Promise.resolve({
            skills: [{ ...reviewSkill, id: "channel-skill", name: "channel-skill" }],
            count: 1,
          })
    ));

    const view = renderPanel();
    view.rerender(
      <TestUiProviders>
        <SkillsPanel scope={channelScope} />
      </TestUiProviders>,
    );

    expect(await screen.findByRole("heading", { name: "channel-skill" })).toBeVisible();
    await act(async () => {
      privateLoad.resolve({ skills: [reviewSkill], count: 1 });
      await privateLoad.promise;
    });

    expect(screen.queryByRole("heading", { name: "review-code" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "channel-skill" })).toBeVisible();
  });
});
