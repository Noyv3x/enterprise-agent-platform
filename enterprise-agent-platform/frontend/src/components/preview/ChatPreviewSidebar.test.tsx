// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALE_STORAGE_KEY } from "../../i18n";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
import { TestUiProviders } from "../../test/TestUiProviders";
import type { AgentPreviewScope, AppState } from "../../types";
import { useChatPreviewContext } from "./ChatPreviewContext";
import { ComputerPip } from "./ComputerPip";
import { ChatPreviewSidebar } from "./ChatPreviewSidebar";

const mocks = vi.hoisted(() => ({
  availability: {
    browserActive: false,
    runningTerminalCount: 0,
    presentAvailable: false,
    loading: false,
    error: "",
  },
  browserRender: vi.fn(),
  browserProps: vi.fn(),
  terminalRender: vi.fn(),
  schedulesRender: vi.fn(),
  memoryRender: vi.fn(),
  skillsRender: vi.fn(),
  skillsCanManageRender: vi.fn(),
  mobile: false,
}));

vi.mock("./usePreviewAvailability", () => ({
  usePreviewAvailability: () => ({
    state: { ...mocks.availability },
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

function PreviewHeaderFixture() {
  const preview = useChatPreviewContext();
  return <header>{preview?.capabilityActions}</header>;
}

function renderSidebar(
  scope: AgentPreviewScope | null = privateScope,
  canManageSkills = true,
  children: ReactNode = <div>Chat content</div>,
  state: AppState = initialAppState,
) {
  const store = createStore(rootReducer, state);
  return render(
    <StoreContext.Provider value={store}>
      <TestUiProviders>
        <ChatPreviewSidebar
          scope={scope}
          canManageSkills={canManageSkills}
        >
          <PreviewHeaderFixture />
          {children}
        </ChatPreviewSidebar>
      </TestUiProviders>
    </StoreContext.Provider>,
  );
}

function BrowserAssistFixture() {
  const preview = useChatPreviewContext();
  return (
    <button
      type="button"
      onClick={(event) => preview?.openBrowserAssist(event.currentTarget)}
    >
      Open browser from work
    </button>
  );
}

async function waitForOpenPreview(name: string) {
  const dialog = await screen.findByRole("dialog", { name });
  await waitFor(() => expect(dialog).toBeVisible());
  return dialog;
}

async function waitForClosedPreview() {
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
}

describe("ChatPreviewSidebar", () => {
  beforeEach(() => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    mocks.availability.browserActive = false;
    mocks.availability.runningTerminalCount = 0;
    mocks.availability.presentAvailable = false;
    mocks.availability.loading = false;
    mocks.availability.error = "";
    mocks.browserRender.mockClear();
    mocks.browserProps.mockClear();
    mocks.terminalRender.mockClear();
    mocks.schedulesRender.mockClear();
    mocks.memoryRender.mockClear();
    mocks.skillsRender.mockClear();
    mocks.skillsCanManageRender.mockClear();
    mocks.mobile = false;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string): MediaQueryList => ({
        matches: query === "(prefers-reduced-motion: reduce)" ||
          (query === "(max-width: 520px)" && mocks.mobile),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("keeps private memory, Skill, and task entries visible while the computer is idle", () => {
    renderSidebar();

    expect(screen.getByText("Chat content")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open memory manager" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Skill manager" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open scheduled tasks" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Show the AI computer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open browser preview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open terminal preview/ })).not.toBeInTheDocument();
    expect(mocks.browserRender).not.toHaveBeenCalled();
    expect(mocks.terminalRender).not.toHaveBeenCalled();
  });

  it("opens Agent-scoped Skill management for private and channel chats", async () => {
    const view = renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "Open Skill manager" }));

    await waitForOpenPreview("Skills");
    expect(await screen.findByTestId("skills-panel-fixture")).toBeVisible();
    expect(mocks.skillsRender).toHaveBeenLastCalledWith(privateScope);

    const channelScope: AgentPreviewScope = { scope_type: "channel", scope_id: "4" };
    view.rerender(
      <StoreContext.Provider value={createStore(rootReducer, initialAppState)}>
        <TestUiProviders>
          <ChatPreviewSidebar scope={channelScope}>
            <PreviewHeaderFixture />
            <div>Channel chat</div>
          </ChatPreviewSidebar>
        </TestUiProviders>
      </StoreContext.Provider>,
    );
    await waitForClosedPreview();
    expect(screen.getByRole("button", { name: "Open Skill manager" })).toBeVisible();
    expect(screen.queryByTestId("skills-panel-fixture")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Open Skill manager" }));
    await waitForOpenPreview("Skills");
    expect(await screen.findByTestId("skills-panel-fixture")).toBeVisible();
    expect(mocks.skillsRender).toHaveBeenLastCalledWith(channelScope);
  });

  it("passes read-only Skill management state to the lazy panel", async () => {
    renderSidebar(
      { scope_type: "channel", scope_id: "4" },
      false,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open Skill manager" }));
    await waitForOpenPreview("Skills");

    expect(await screen.findByTestId("skills-panel-fixture")).toBeVisible();
    expect(mocks.skillsCanManageRender).toHaveBeenLastCalledWith(false);
  });

  it("opens memory management on demand only for a private Agent", async () => {
    const view = renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "Open memory manager" }));
    await waitForOpenPreview("Memory");
    expect(await screen.findByTestId("memory-panel-fixture")).toBeVisible();

    view.rerender(
      <StoreContext.Provider value={createStore(rootReducer, initialAppState)}>
        <TestUiProviders>
          <ChatPreviewSidebar scope={{ scope_type: "channel", scope_id: "4" }}>
            <PreviewHeaderFixture />
            <div>Channel chat</div>
          </ChatPreviewSidebar>
        </TestUiProviders>
      </StoreContext.Provider>,
    );
    await waitForClosedPreview();
    expect(screen.queryByRole("button", { name: "Open memory manager" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("memory-panel-fixture")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Skill manager" })).toBeVisible();
  });

  it("opens scheduled tasks on demand only for a private Agent", async () => {
    const view = renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "Open scheduled tasks" }));
    await waitForOpenPreview("Scheduled tasks");
    expect(await screen.findByTestId("scheduled-tasks-fixture")).toBeVisible();

    view.rerender(
      <StoreContext.Provider value={createStore(rootReducer, initialAppState)}>
        <TestUiProviders>
          <ChatPreviewSidebar scope={{ scope_type: "channel", scope_id: "4" }}>
            <PreviewHeaderFixture />
            <div>Channel chat</div>
          </ChatPreviewSidebar>
        </TestUiProviders>
      </StoreContext.Provider>,
    );
    await waitForClosedPreview();
    expect(screen.queryByRole("button", { name: "Open scheduled tasks" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("scheduled-tasks-fixture")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Skill manager" })).toBeVisible();
  });

  it("unifies browser and terminal into one computer rail item titled AI computer", async () => {
    mocks.availability.browserActive = true;
    mocks.availability.runningTerminalCount = 2;
    renderSidebar();

    const computerButton = screen.getByRole("button", { name: "Show the AI computer" });
    expect(screen.queryByRole("button", { name: "Open browser preview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open terminal preview/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open scheduled tasks" })).toBeVisible();

    await userEvent.click(computerButton);

    expect(computerButton).toHaveAttribute("aria-expanded", "true");
    const computerDrawer = await waitForOpenPreview("AI computer");
    const browserFixture = screen.getByTestId("browser-preview-fixture");
    expect(computerDrawer).toBeVisible();
    expect(browserFixture).toBeVisible();
    expect(mocks.browserProps).toHaveBeenLastCalledWith(expect.objectContaining({ controlRequestId: undefined }));
  });

  it("opens from a work-record intent before availability and issues one monotonic control request", async () => {
    const user = userEvent.setup();
    renderSidebar(privateScope, true, <BrowserAssistFixture />);

    expect(screen.queryByRole("button", { name: "Show the AI computer" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open browser from work" }));

    await waitForOpenPreview("AI computer");
    expect(screen.getByTestId("browser-preview-fixture")).toBeVisible();
    expect(mocks.browserProps).toHaveBeenLastCalledWith(expect.objectContaining({ controlRequestId: 1 }));

    await user.click(screen.getByRole("button", { name: "Close preview" }));
    await waitForClosedPreview();
    await user.click(screen.getByRole("button", { name: "Open browser from work" }));
    await waitForOpenPreview("AI computer");
    expect(mocks.browserProps).toHaveBeenLastCalledWith(expect.objectContaining({ controlRequestId: 2 }));
  });

  it("clears a pending work-record browser intent when the chat scope changes", async () => {
    const user = userEvent.setup();
    const view = renderSidebar(privateScope, true, <BrowserAssistFixture />);
    await user.click(screen.getByRole("button", { name: "Open browser from work" }));
    await waitForOpenPreview("AI computer");
    const browserRenderCount = mocks.browserRender.mock.calls.length;

    view.rerender(
      <StoreContext.Provider value={createStore(rootReducer, initialAppState)}>
        <TestUiProviders>
          <ChatPreviewSidebar scope={{ scope_type: "channel", scope_id: "4" }}>
            <PreviewHeaderFixture />
            <BrowserAssistFixture />
          </ChatPreviewSidebar>
        </TestUiProviders>
      </StoreContext.Provider>,
    );

    await waitForClosedPreview();
    expect(mocks.browserRender).toHaveBeenCalledTimes(browserRenderCount);
    await user.click(screen.getByRole("button", { name: "Open browser from work" }));
    await waitForOpenPreview("AI computer");
    expect(mocks.browserProps).toHaveBeenLastCalledWith(expect.objectContaining({ controlRequestId: 1 }));
  });

  it("closes with Escape and restores focus to the computer trigger", async () => {
    mocks.availability.browserActive = true;
    const user = userEvent.setup();
    renderSidebar();
    const computerButton = screen.getByRole("button", { name: "Show the AI computer" });

    await user.click(computerButton);
    const dialog = await waitForOpenPreview("AI computer");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    await user.keyboard("{Escape}");

    await waitForClosedPreview();
    await waitFor(() => expect(computerButton).toHaveFocus());
  });

  it("moves focus into the mobile preview and restores the trigger on Escape", async () => {
    mocks.mobile = true;
    const user = userEvent.setup();
    renderSidebar();
    const skillsButton = screen.getByRole("button", { name: "Open Skill manager" });

    await user.click(skillsButton);

    const dialog = await waitForOpenPreview("Skills");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    await user.keyboard("{Escape}");
    await waitForClosedPreview();

    await waitFor(() => expect(skillsButton).toHaveFocus());
  });

  it("returns focus to the composer when a mobile PiP opener unmounts", async () => {
    mocks.mobile = true;
    const user = userEvent.setup();
    const state: AppState = {
      ...initialAppState,
      agentStatuses: {
        ...initialAppState.agentStatuses,
        private: {
          state: "replying",
          run_id: "run-mobile-pip",
          started_at: Math.floor(Date.now() / 1_000),
          computer: {
            mode: "search",
            search: {
              tool: "web",
              hits: [{ title: "Live search result", url: "https://example.test" }],
            },
          },
        },
      },
    };
    renderSidebar(
      privateScope,
      true,
      <section aria-label="Chat composer">
        <textarea data-composer-input aria-label="Message input" />
        <ComputerPip />
      </section>,
      state,
    );
    const composer = screen.getByRole("textbox", { name: "Message input" });
    const pipButton = within(screen.getByRole("region", { name: "Chat composer" }))
      .getByRole("button", { name: "Show the AI computer" });
    expect(pipButton).toBeVisible();

    await user.click(pipButton!);

    expect(pipButton?.isConnected).toBe(false);
    const dialog = await waitForOpenPreview("AI computer");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await user.keyboard("{Escape}");
    await waitForClosedPreview();

    await waitFor(() => expect(composer).toHaveFocus());
  });

  it("keeps scheduled tasks and the computer drawer mutually exclusive", async () => {
    mocks.availability.browserActive = true;
    renderSidebar();

    await userEvent.click(screen.getByRole("button", { name: "Open scheduled tasks" }));
    await waitForOpenPreview("Scheduled tasks");
    const scheduledFixture = await screen.findByTestId("scheduled-tasks-fixture");
    expect(scheduledFixture).toBeVisible();
    expect(screen.queryByTestId("browser-preview-fixture")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Close preview" }));
    await waitForClosedPreview();
    await userEvent.click(screen.getByRole("button", { name: "Show the AI computer" }));
    await waitForOpenPreview("AI computer");
    expect(screen.queryByTestId("scheduled-tasks-fixture")).not.toBeInTheDocument();
    expect(screen.getByTestId("browser-preview-fixture")).toBeVisible();
  });

  it("keeps memory and scheduled tasks mutually exclusive", async () => {
    renderSidebar();

    await userEvent.click(screen.getByRole("button", { name: "Open memory manager" }));
    await waitForOpenPreview("Memory");
    expect(await screen.findByTestId("memory-panel-fixture")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Close preview" }));
    await waitForClosedPreview();
    await userEvent.click(screen.getByRole("button", { name: "Open scheduled tasks" }));
    await waitForOpenPreview("Scheduled tasks");
    expect(screen.queryByTestId("memory-panel-fixture")).not.toBeInTheDocument();
    expect(await screen.findByTestId("scheduled-tasks-fixture")).toBeVisible();
  });

  it("shows the computer for running terminals and closes it when they finish", async () => {
    mocks.availability.runningTerminalCount = 2;
    const view = renderSidebar();

    await userEvent.click(screen.getByRole("button", { name: "Show the AI computer" }));
    await waitForOpenPreview("AI computer");
    expect(screen.getByTestId("terminal-preview-fixture")).toBeVisible();

    mocks.availability.runningTerminalCount = 0;
    view.rerender(
      <StoreContext.Provider value={createStore(rootReducer, initialAppState)}>
        <TestUiProviders>
          <ChatPreviewSidebar scope={privateScope}>
            <PreviewHeaderFixture />
            <div>Chat content</div>
          </ChatPreviewSidebar>
        </TestUiProviders>
      </StoreContext.Provider>,
    );

    expect(screen.queryByRole("button", { name: "Show the AI computer" })).not.toBeInTheDocument();
    await waitForClosedPreview();
  });

  it("closes an open preview when the active chat scope changes", async () => {
    mocks.availability.browserActive = true;
    const view = renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "Show the AI computer" }));
    await waitForOpenPreview("AI computer");

    view.rerender(
      <StoreContext.Provider value={createStore(rootReducer, initialAppState)}>
        <TestUiProviders>
          <ChatPreviewSidebar scope={{ scope_type: "channel", scope_id: "4" }}>
            <PreviewHeaderFixture />
            <div>Other chat</div>
          </ChatPreviewSidebar>
        </TestUiProviders>
      </StoreContext.Provider>,
    );

    await waitForClosedPreview();
    expect(screen.getByText("Other chat")).toBeVisible();
  });

  it("shows a failed HTML projection instead of waiting for unavailable presentation content", async () => {
    renderSidebar(privateScope, true, <div>Chat content</div>, {
      ...initialAppState,
      agentStatuses: {
        ...initialAppState.agentStatuses,
        private: {
          state: "replying",
          run_id: "failed-html-run",
          computer: {
            mode: "present",
            present: {
              workspace_path: "report.html",
              status: "failed",
              revision: "html:failed",
            },
          },
        },
      },
    });

    await userEvent.click(screen.getByRole("button", { name: "Show the AI computer" }));
    const computer = await waitForOpenPreview("AI computer");
    expect(within(computer).getByText("The page could not be shown. Chat is unaffected.")).toBeVisible();
    expect(within(computer).queryByTitle("Presented page")).not.toBeInTheDocument();
    expect(within(computer).queryByText("Preparing the AI computer")).not.toBeInTheDocument();
  });

  it("keeps a present page computer entry after the run ends", () => {
    mocks.availability.presentAvailable = true;
    renderSidebar();
    expect(screen.getByRole("button", { name: "Show the AI computer" })).toBeVisible();
  });
});
