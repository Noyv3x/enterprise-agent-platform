// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import type { AgentPreviewScope } from "../../types";
import { useChatPreviewContext } from "./ChatPreviewContext";
import { ChatPreviewSidebar } from "./ChatPreviewSidebar";

const mocks = vi.hoisted(() => ({
  availability: {
    browserActive: false,
    runningTerminalCount: 0,
  },
  browserRender: vi.fn(),
  browserProps: vi.fn(),
  terminalRender: vi.fn(),
  schedulesRender: vi.fn(),
  memoryRender: vi.fn(),
  skillsRender: vi.fn(),
  skillsCanManageRender: vi.fn(),
}));

vi.mock("./usePreviewAvailability", () => ({
  usePreviewAvailability: () => ({
    state: {
      ...mocks.availability,
      loading: false,
      error: "",
    },
    refresh: vi.fn(),
  }),
}));

vi.mock("./BrowserPreviewView", () => ({
  BrowserPreviewView: (props: { controlRequestId?: number }) => {
    mocks.browserRender();
    mocks.browserProps(props);
    return <div data-testid="browser-preview-fixture" />;
  },
}));

vi.mock("./TerminalPreviewView", () => ({
  TerminalPreviewView: () => {
    mocks.terminalRender();
    return <div data-testid="terminal-preview-fixture" />;
  },
}));

vi.mock("../scheduled-tasks/ScheduledTasksPanel", () => ({
  ScheduledTasksPanel: () => {
    mocks.schedulesRender();
    return <div data-testid="scheduled-tasks-fixture" />;
  },
}));

vi.mock("../memory/MemoryPanel", () => ({
  MemoryPanel: () => {
    mocks.memoryRender();
    return <div data-testid="memory-panel-fixture" />;
  },
}));

vi.mock("../skills/SkillsPanel", () => ({
  SkillsPanel: ({
    scope,
    canManage,
  }: {
    scope: AgentPreviewScope;
    canManage?: boolean;
  }) => {
    mocks.skillsRender(scope);
    mocks.skillsCanManageRender(canManage);
    return <div data-testid="skills-panel-fixture" />;
  },
}));

const privateScope: AgentPreviewScope = { scope_type: "private", scope_id: "7" };

function renderSidebar(
  scope: AgentPreviewScope | null = privateScope,
  canManageSkills = true,
  children: ReactNode = <div>Chat content</div>,
) {
  return render(
    <I18nProvider>
      <ChatPreviewSidebar
        scope={scope}
        canManageSkills={canManageSkills}
      >
        {children}
      </ChatPreviewSidebar>
    </I18nProvider>,
  );
}

function BrowserAssistFixture() {
  const preview = useChatPreviewContext();
  return (
    <button type="button" onClick={preview?.openBrowserAssist}>
      Open browser from work
    </button>
  );
}

describe("ChatPreviewSidebar", () => {
  beforeEach(() => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    mocks.availability.browserActive = false;
    mocks.availability.runningTerminalCount = 0;
    mocks.browserRender.mockClear();
    mocks.browserProps.mockClear();
    mocks.terminalRender.mockClear();
    mocks.schedulesRender.mockClear();
    mocks.memoryRender.mockClear();
    mocks.skillsRender.mockClear();
    mocks.skillsCanManageRender.mockClear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("keeps private memory, Skill, and task entries visible while live preview resources are idle", () => {
    renderSidebar();

    expect(screen.getByText("Chat content")).toBeVisible();
    expect(screen.getByRole("navigation", { name: "Agent side tools" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open memory manager" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Skill manager" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open scheduled tasks" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open browser preview" })).not.toBeInTheDocument();
    expect(mocks.browserRender).not.toHaveBeenCalled();
    expect(mocks.terminalRender).not.toHaveBeenCalled();
    expect(mocks.schedulesRender).not.toHaveBeenCalled();
    expect(mocks.memoryRender).not.toHaveBeenCalled();
    expect(mocks.skillsRender).not.toHaveBeenCalled();
  });

  it("opens Agent-scoped Skill management for private and channel chats", async () => {
    const view = renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "Open Skill manager" }));

    expect(screen.getByRole("complementary", { name: "Skills" })).toBeVisible();
    expect(await screen.findByTestId("skills-panel-fixture")).toBeVisible();
    expect(mocks.skillsRender).toHaveBeenLastCalledWith(privateScope);

    const channelScope: AgentPreviewScope = { scope_type: "channel", scope_id: "4" };
    view.rerender(
      <I18nProvider>
        <ChatPreviewSidebar scope={channelScope}>
          <div>Channel chat</div>
        </ChatPreviewSidebar>
      </I18nProvider>,
    );
    expect(screen.getByRole("button", { name: "Open Skill manager" })).toBeVisible();
    expect(screen.queryByTestId("skills-panel-fixture")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Open Skill manager" }));
    expect(await screen.findByTestId("skills-panel-fixture")).toBeVisible();
    expect(mocks.skillsRender).toHaveBeenLastCalledWith(channelScope);
  });

  it("passes read-only Skill management state to the lazy panel", async () => {
    renderSidebar(
      { scope_type: "channel", scope_id: "4" },
      false,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open Skill manager" }));

    expect(await screen.findByTestId("skills-panel-fixture")).toBeVisible();
    expect(mocks.skillsCanManageRender).toHaveBeenLastCalledWith(false);
  });

  it("opens memory management on demand only for a private Agent", async () => {
    const view = renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "Open memory manager" }));
    expect(screen.getByRole("complementary", { name: "Memory" })).toBeVisible();
    expect(await screen.findByTestId("memory-panel-fixture")).toBeVisible();

    view.rerender(
      <I18nProvider>
        <ChatPreviewSidebar scope={{ scope_type: "channel", scope_id: "4" }}>
          <div>Channel chat</div>
        </ChatPreviewSidebar>
      </I18nProvider>,
    );
    expect(screen.queryByRole("button", { name: "Open memory manager" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("memory-panel-fixture")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Skill manager" })).toBeVisible();
  });

  it("opens scheduled tasks on demand only for a private Agent", async () => {
    const view = renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "Open scheduled tasks" }));
    expect(screen.getByRole("complementary", { name: "Scheduled tasks" })).toBeVisible();
    expect(await screen.findByTestId("scheduled-tasks-fixture")).toBeVisible();

    view.rerender(
      <I18nProvider>
        <ChatPreviewSidebar scope={{ scope_type: "channel", scope_id: "4" }}>
          <div>Channel chat</div>
        </ChatPreviewSidebar>
      </I18nProvider>,
    );
    expect(screen.queryByRole("button", { name: "Open scheduled tasks" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("scheduled-tasks-fixture")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Skill manager" })).toBeVisible();
  });

  it("shows only the active browser control and mounts the full preview on demand", async () => {
    mocks.availability.browserActive = true;
    renderSidebar();

    const browserButton = screen.getByRole("button", { name: "Open browser preview" });
    expect(screen.queryByRole("button", { name: /Open terminal preview/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open scheduled tasks" })).toBeVisible();
    expect(mocks.browserRender).not.toHaveBeenCalled();

    await userEvent.click(browserButton);

    expect(browserButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("complementary", { name: "Live browser preview" })).toBeVisible();
    expect(screen.getByTestId("browser-preview-fixture")).toBeVisible();
    expect(mocks.browserRender).toHaveBeenCalled();
    expect(mocks.browserProps).toHaveBeenLastCalledWith(expect.objectContaining({ controlRequestId: undefined }));
  });

  it("opens from a work-record intent before availability and issues one monotonic control request", async () => {
    const user = userEvent.setup();
    renderSidebar(privateScope, true, <BrowserAssistFixture />);

    expect(screen.queryByRole("button", { name: "Open browser preview" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open browser from work" }));

    expect(screen.getByRole("complementary", { name: "Live browser preview" })).toBeVisible();
    expect(screen.getByTestId("browser-preview-fixture")).toBeVisible();
    expect(mocks.browserProps).toHaveBeenLastCalledWith(expect.objectContaining({ controlRequestId: 1 }));

    await user.click(screen.getByRole("button", { name: "Close preview" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open browser from work" }));
    expect(mocks.browserProps).toHaveBeenLastCalledWith(expect.objectContaining({ controlRequestId: 2 }));
  });

  it("clears a pending work-record browser intent when the chat scope changes", async () => {
    const user = userEvent.setup();
    const view = renderSidebar(privateScope, true, <BrowserAssistFixture />);
    await user.click(screen.getByRole("button", { name: "Open browser from work" }));
    expect(screen.getByRole("complementary")).toBeVisible();
    const browserRenderCount = mocks.browserRender.mock.calls.length;

    view.rerender(
      <I18nProvider>
        <ChatPreviewSidebar scope={{ scope_type: "channel", scope_id: "4" }}>
          <BrowserAssistFixture />
        </ChatPreviewSidebar>
      </I18nProvider>,
    );

    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(mocks.browserRender).toHaveBeenCalledTimes(browserRenderCount);
    await user.click(screen.getByRole("button", { name: "Open browser from work" }));
    expect(mocks.browserProps).toHaveBeenLastCalledWith(expect.objectContaining({ controlRequestId: 1 }));
  });

  it("closes with Escape and restores focus to the preview trigger", async () => {
    mocks.availability.browserActive = true;
    const user = userEvent.setup();
    renderSidebar();
    const browserButton = screen.getByRole("button", { name: "Open browser preview" });

    await user.click(browserButton);
    expect(screen.getByRole("complementary", { name: "Live browser preview" })).toBeVisible();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    await waitFor(() => expect(browserButton).toHaveFocus());
  });

  it("keeps scheduled tasks and live previews mutually exclusive", async () => {
    mocks.availability.browserActive = true;
    renderSidebar();

    await userEvent.click(screen.getByRole("button", { name: "Open scheduled tasks" }));
    expect(await screen.findByTestId("scheduled-tasks-fixture")).toBeVisible();
    expect(screen.queryByTestId("browser-preview-fixture")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Open browser preview" }));
    expect(screen.queryByTestId("scheduled-tasks-fixture")).not.toBeInTheDocument();
    expect(screen.getByTestId("browser-preview-fixture")).toBeVisible();
  });

  it("keeps memory and scheduled tasks mutually exclusive", async () => {
    renderSidebar();

    await userEvent.click(screen.getByRole("button", { name: "Open memory manager" }));
    expect(await screen.findByTestId("memory-panel-fixture")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Open scheduled tasks" }));
    expect(screen.queryByTestId("memory-panel-fixture")).not.toBeInTheDocument();
    expect(await screen.findByTestId("scheduled-tasks-fixture")).toBeVisible();
  });

  it("shows the running terminal count and closes the drawer as soon as terminals finish", async () => {
    mocks.availability.browserActive = true;
    mocks.availability.runningTerminalCount = 2;
    const view = renderSidebar();

    await userEvent.click(screen.getByRole("button", { name: "Open terminal previews (2)" }));
    expect(screen.getByRole("complementary", { name: "Live terminal preview" })).toBeVisible();
    expect(screen.getByTestId("terminal-preview-fixture")).toBeVisible();

    mocks.availability.runningTerminalCount = 0;
    view.rerender(
      <I18nProvider>
        <ChatPreviewSidebar scope={privateScope}>
          <div>Chat content</div>
        </ChatPreviewSidebar>
      </I18nProvider>,
    );

    expect(screen.queryByRole("button", { name: /Open terminal preview/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open browser preview" })).toBeVisible();
  });

  it("closes an open preview when the active chat scope changes", async () => {
    mocks.availability.browserActive = true;
    const view = renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "Open browser preview" }));
    expect(screen.getByRole("complementary")).toBeVisible();

    view.rerender(
      <I18nProvider>
        <ChatPreviewSidebar scope={{ scope_type: "channel", scope_id: "4" }}>
          <div>Other chat</div>
        </ChatPreviewSidebar>
      </I18nProvider>,
    );

    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.getByText("Other chat")).toBeVisible();
  });
});
