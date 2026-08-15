// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
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

function renderSidebar(
  scope: AgentPreviewScope | null = privateScope,
  canManageSkills = true,
  children: ReactNode = <div>Chat content</div>,
  state: AppState = initialAppState,
) {
  const store = createStore(rootReducer, state);
  return render(
    <StoreContext.Provider value={store}>
      <I18nProvider>
        <ChatPreviewSidebar
          scope={scope}
          canManageSkills={canManageSkills}
        >
          {children}
        </ChatPreviewSidebar>
      </I18nProvider>
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
        matches: query === "(max-width: 520px)" && mocks.mobile,
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
    expect(screen.getByRole("navigation", { name: "Agent side tools" })).toBeVisible();
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

    expect(screen.getByRole("complementary", { name: "Skills" })).toBeVisible();
    expect(await screen.findByTestId("skills-panel-fixture")).toBeVisible();
    expect(mocks.skillsRender).toHaveBeenLastCalledWith(privateScope);

    const channelScope: AgentPreviewScope = { scope_type: "channel", scope_id: "4" };
    view.rerender(
      <StoreContext.Provider value={createStore(rootReducer, initialAppState)}>
        <I18nProvider>
          <ChatPreviewSidebar scope={channelScope}>
            <div>Channel chat</div>
          </ChatPreviewSidebar>
        </I18nProvider>
      </StoreContext.Provider>,
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
      <StoreContext.Provider value={createStore(rootReducer, initialAppState)}>
        <I18nProvider>
          <ChatPreviewSidebar scope={{ scope_type: "channel", scope_id: "4" }}>
            <div>Channel chat</div>
          </ChatPreviewSidebar>
        </I18nProvider>
      </StoreContext.Provider>,
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
      <StoreContext.Provider value={createStore(rootReducer, initialAppState)}>
        <I18nProvider>
          <ChatPreviewSidebar scope={{ scope_type: "channel", scope_id: "4" }}>
            <div>Channel chat</div>
          </ChatPreviewSidebar>
        </I18nProvider>
      </StoreContext.Provider>,
    );
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
    const computerDrawer = screen.getByRole("complementary", { name: "AI computer" });
    const browserFixture = screen.getByTestId("browser-preview-fixture");
    expect(computerDrawer).toBeVisible();
    expect(computerDrawer.querySelector(".chat-preview__body--computer")).not.toBeNull();
    expect(browserFixture).toBeVisible();
    expect(browserFixture.closest(".computer-screen__viewport.is-browser")).not.toBeNull();
    expect(mocks.browserProps).toHaveBeenLastCalledWith(expect.objectContaining({ controlRequestId: undefined }));
  });

  it("opens from a work-record intent before availability and issues one monotonic control request", async () => {
    const user = userEvent.setup();
    renderSidebar(privateScope, true, <BrowserAssistFixture />);

    expect(screen.queryByRole("button", { name: "Show the AI computer" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open browser from work" }));

    expect(screen.getByRole("complementary", { name: "AI computer" })).toBeVisible();
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
      <StoreContext.Provider value={createStore(rootReducer, initialAppState)}>
        <I18nProvider>
          <ChatPreviewSidebar scope={{ scope_type: "channel", scope_id: "4" }}>
            <BrowserAssistFixture />
          </ChatPreviewSidebar>
        </I18nProvider>
      </StoreContext.Provider>,
    );

    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(mocks.browserRender).toHaveBeenCalledTimes(browserRenderCount);
    await user.click(screen.getByRole("button", { name: "Open browser from work" }));
    expect(mocks.browserProps).toHaveBeenLastCalledWith(expect.objectContaining({ controlRequestId: 1 }));
  });

  it("closes with Escape and restores focus to the computer trigger", async () => {
    mocks.availability.browserActive = true;
    const user = userEvent.setup();
    renderSidebar();
    const computerButton = screen.getByRole("button", { name: "Show the AI computer" });

    await user.click(computerButton);
    expect(screen.getByRole("complementary", { name: "AI computer" })).toBeVisible();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    await waitFor(() => expect(computerButton).toHaveFocus());
  });

  it("moves focus into a full-width mobile preview and makes covered controls inert", async () => {
    mocks.mobile = true;
    const user = userEvent.setup();
    renderSidebar();
    const skillsButton = screen.getByRole("button", { name: "Open Skill manager" });
    const chat = screen.getByText("Chat content").closest(".chat");
    const rail = screen.getByRole("navigation", { name: "Agent side tools" });

    await user.click(skillsButton);

    const close = screen.getByRole("button", { name: "Close preview" });
    await waitFor(() => expect(close).toHaveFocus());
    expect(chat).toHaveAttribute("inert");
    expect(chat).toHaveAttribute("aria-hidden", "true");
    expect(rail).toHaveAttribute("inert");
    expect(rail).toHaveAttribute("aria-hidden", "true");

    await user.keyboard("{Escape}");

    await waitFor(() => expect(skillsButton).toHaveFocus());
    expect(chat).not.toHaveAttribute("inert");
    expect(chat).not.toHaveAttribute("aria-hidden");
    expect(rail).not.toHaveAttribute("inert");
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
      <div className="composer">
        <textarea aria-label="Message input" />
        <ComputerPip />
      </div>,
      state,
    );
    const composer = screen.getByRole("textbox", { name: "Message input" });
    const pipButton = document.querySelector<HTMLButtonElement>(".computer-pip__button");
    expect(pipButton).not.toBeNull();

    await user.click(pipButton!);

    expect(pipButton?.isConnected).toBe(false);
    const close = screen.getByRole("button", { name: "Close preview" });
    await waitFor(() => expect(close).toHaveFocus());
    await user.keyboard("{Escape}");

    await waitFor(() => expect(composer).toHaveFocus());
  });

  it("keeps scheduled tasks and the computer drawer mutually exclusive", async () => {
    mocks.availability.browserActive = true;
    renderSidebar();

    await userEvent.click(screen.getByRole("button", { name: "Open scheduled tasks" }));
    const scheduledFixture = await screen.findByTestId("scheduled-tasks-fixture");
    expect(scheduledFixture).toBeVisible();
    expect(scheduledFixture.closest(".chat-preview__body")).not.toHaveClass("chat-preview__body--computer");
    expect(screen.queryByTestId("browser-preview-fixture")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show the AI computer" }));
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

  it("shows the computer for running terminals and closes it when they finish", async () => {
    mocks.availability.runningTerminalCount = 2;
    const view = renderSidebar();

    await userEvent.click(screen.getByRole("button", { name: "Show the AI computer" }));
    expect(screen.getByRole("complementary", { name: "AI computer" })).toBeVisible();
    expect(screen.getByTestId("terminal-preview-fixture")).toBeVisible();

    mocks.availability.runningTerminalCount = 0;
    view.rerender(
      <StoreContext.Provider value={createStore(rootReducer, initialAppState)}>
        <I18nProvider>
          <ChatPreviewSidebar scope={privateScope}>
            <div>Chat content</div>
          </ChatPreviewSidebar>
        </I18nProvider>
      </StoreContext.Provider>,
    );

    expect(screen.queryByRole("button", { name: "Show the AI computer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("closes an open preview when the active chat scope changes", async () => {
    mocks.availability.browserActive = true;
    const view = renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "Show the AI computer" }));
    expect(screen.getByRole("complementary")).toBeVisible();

    view.rerender(
      <StoreContext.Provider value={createStore(rootReducer, initialAppState)}>
        <I18nProvider>
          <ChatPreviewSidebar scope={{ scope_type: "channel", scope_id: "4" }}>
            <div>Other chat</div>
          </ChatPreviewSidebar>
        </I18nProvider>
      </StoreContext.Provider>,
    );

    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.getByText("Other chat")).toBeVisible();
  });

  it("keeps a present page computer entry after the run ends", () => {
    mocks.availability.presentAvailable = true;
    renderSidebar();
    expect(screen.getByRole("button", { name: "Show the AI computer" })).toBeVisible();
  });
});
