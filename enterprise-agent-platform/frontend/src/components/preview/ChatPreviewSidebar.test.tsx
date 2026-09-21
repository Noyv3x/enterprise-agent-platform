// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as PreviewActions from "../../data/previewActions";
import { LOCALE_STORAGE_KEY } from "../../i18n";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
import { TestUiProviders } from "../../test/TestUiProviders";
import type { AgentPreviewScope, AgentStatus, AppState } from "../../types";
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
  browserState: {
    connection: "connected",
    activity: "live",
    frameUrl: "blob:live-frame",
    tabId: "tab-1",
    error: "",
    title: "",
    url: "",
    capturedAt: "",
    checkedAt: null,
  },
  acquire: vi.fn(),
  release: vi.fn(),
  input: vi.fn(),
  terminalRender: vi.fn(),
  schedulesRender: vi.fn(),
  memoryRender: vi.fn(),
  viewportWidth: 1440,
}));

vi.mock("./usePreviewAvailability", () => ({
  usePreviewAvailability: () => ({
    state: { ...mocks.availability },
    refresh: vi.fn(),
  }),
}));

vi.mock("./useBrowserPreview", () => ({
  useBrowserPreview: () => ({ state: mocks.browserState, refresh: vi.fn() }),
}));

vi.mock("../../data/previewActions", async () => {
  const actual = await vi.importActual<typeof PreviewActions>("../../data/previewActions");
  return {
    ...actual,
    acquireBrowserControl: mocks.acquire,
    releaseBrowserControl: mocks.release,
    sendBrowserControlInput: mocks.input,
  };
});

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
  SkillsPanel: () => <div data-testid="skills-panel-fixture" />,
}));

const privateScope: AgentPreviewScope = { scope_type: "private", scope_id: "7" };
const defaultMatchMedia = window.matchMedia;
const defaultDocumentHidden = Object.getOwnPropertyDescriptor(document, "hidden");
const mediaQueries = new Map<string, MediaQueryList>();

function matchesViewport(query: string) {
  if (query === "(prefers-reduced-motion: reduce)") return true;
  return query.split(",").some((part) => {
    const widths = [...part.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)];
    return widths.length > 0 && widths.every(([, bound, width]) => (
      bound === "min" ? mocks.viewportWidth >= Number(width) : mocks.viewportWidth <= Number(width)
    ));
  });
}

function changeViewport(width: number) {
  act(() => {
    mocks.viewportWidth = width;
    for (const media of mediaQueries.values()) {
      media.dispatchEvent(Object.assign(new Event("change"), {
        matches: media.matches,
        media: media.media,
      }));
    }
  });
}

function ChatComposerFixture() {
  return (
    <>
      <section aria-label="Computer preview"><ComputerPip /></section>
      <section aria-label="Chat composer">
        <textarea data-composer-input aria-label="Message input" />
      </section>
    </>
  );
}

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
  const view = render(
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
  return { ...view, store };
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
  const role = name === "AI computer" ? "complementary" : "dialog";
  const panel = await screen.findByRole(role, { name });
  await waitFor(() => expect(panel).toBeVisible());
  return panel;
}

async function waitForClosedPreview() {
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "AI computer" })).not.toBeInTheDocument();
  });
}

describe("ChatPreviewSidebar", () => {
  beforeEach(() => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    mocks.availability.browserActive = false;
    mocks.availability.runningTerminalCount = 0;
    mocks.availability.presentAvailable = false;
    mocks.availability.loading = false;
    mocks.availability.error = "";
    mocks.acquire.mockReset().mockResolvedValue({
      active: true,
      lease_id: "lease-1",
      tab_id: "tab-1",
      expires_in_ms: 90_000,
    });
    mocks.release.mockReset().mockResolvedValue({ active: false, released: true });
    mocks.input.mockReset().mockResolvedValue({ ok: true, expires_in_ms: 90_000 });
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    mocks.terminalRender.mockClear();
    mocks.schedulesRender.mockClear();
    mocks.memoryRender.mockClear();
    mocks.viewportWidth = 1440;
    mediaQueries.clear();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string): MediaQueryList => {
        const cached = mediaQueries.get(query);
        if (cached) return cached;
        const events = new EventTarget();
        const media: MediaQueryList = {
          get matches() { return matchesViewport(query); },
          media: query,
          onchange: null,
          addListener: (listener) => events.addEventListener("change", listener as EventListener),
          removeListener: (listener) => events.removeEventListener("change", listener as EventListener),
          addEventListener: events.addEventListener.bind(events),
          removeEventListener: events.removeEventListener.bind(events),
          dispatchEvent: events.dispatchEvent.bind(events),
        };
        mediaQueries.set(query, media);
        return media;
      },
    });
  });

  afterEach(async () => {
    await act(async () => cleanup());
    localStorage.clear();
    mediaQueries.clear();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: defaultMatchMedia,
    });
    if (defaultDocumentHidden) Object.defineProperty(document, "hidden", defaultDocumentHidden);
    else Reflect.deleteProperty(document, "hidden");
  });

  it("keeps private memory, Skill, and task entries visible while the computer is idle", () => {
    renderSidebar(privateScope, true, <><div>Chat content</div><ChatComposerFixture /></>);

    expect(screen.getByText("Chat content")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open memory manager" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Skill manager" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open scheduled tasks" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Show the AI computer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open browser preview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open terminal preview/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Latest Agent browser frame" })).not.toBeInTheDocument();
    expect(mocks.terminalRender).not.toHaveBeenCalled();
  });

  it.each(["replying", "approval"])("starts %s with a minimized waiting computer before tool content", (state) => {
    renderSidebar(privateScope, true, <ChatComposerFixture />, {
      ...initialAppState,
      agentStatuses: {
        ...initialAppState.agentStatuses,
        private: { state, run_id: "run-waiting" },
      },
    });

    const preview = screen.getByRole("region", { name: "Computer preview" });
    expect(within(preview).getByRole("button", { name: "Show the AI computer" })).toBeVisible();
    expect(within(preview).getByText("Waiting for a work preview")).toBeVisible();
    expect(screen.queryByRole("complementary", { name: "AI computer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "AI computer" })).not.toBeInTheDocument();
    expect(screen.queryByTitle("Presented page")).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Latest Agent browser frame" })).not.toBeInTheDocument();
    expect(mocks.terminalRender).not.toHaveBeenCalled();
  });

  it("keeps status updates minimized until explicitly opened and preserves that choice through tool changes", async () => {
    const user = userEvent.setup();
    const view = renderSidebar(privateScope, true, <ChatComposerFixture />);
    const updateStatus = (status: AgentStatus) => act(() => {
      view.store.dispatch({
        type: "SET_AGENT_STATUS",
        payload: { mode: "private", scopeId: "7", status, authoritative: true },
      });
    });

    updateStatus({ state: "queued", run_id: "queued-run" });
    expect(screen.queryByRole("button", { name: "Show the AI computer" })).not.toBeInTheDocument();
    updateStatus({ state: "replying", run_id: "run-tools" });
    expect(screen.getByText("Waiting for a work preview")).toBeVisible();

    const searchStatus: AgentStatus = {
      state: "replying",
      run_id: "run-tools",
      computer: {
        mode: "search",
        search: { tool: "web", hits: [{ title: "First tool result" }] },
      },
    };
    updateStatus(searchStatus);
    expect(screen.getByText("First tool result")).toBeVisible();
    expect(screen.queryByText("Waiting for a work preview")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "AI computer" })).not.toBeInTheDocument();

    const preview = screen.getByRole("region", { name: "Computer preview" });
    const pip = within(preview).getByRole("button", { name: "Show the AI computer" });
    await user.click(pip);
    const computer = await waitForOpenPreview("AI computer");
    expect(pip.isConnected).toBe(false);
    expect(screen.getAllByText("First tool result")).toHaveLength(1);

    updateStatus({
      ...searchStatus,
      state: "approval",
      computer: {
        mode: "search",
        search: { tool: "search_files", hits: [{ title: "Latest file match", workspace_path: "latest-result.txt" }] },
      },
    });
    expect(within(computer).getByText("latest-result.txt")).toBeVisible();
    expect(screen.queryByText("First tool result")).not.toBeInTheDocument();
    expect(within(preview).queryByRole("button", { name: "Show the AI computer" })).not.toBeInTheDocument();

    await user.click(within(computer).getByRole("button", { name: "Minimize the AI computer" }));
    expect(computer.isConnected).toBe(false);
    expect(screen.getAllByText("latest-result.txt")).toHaveLength(1);
    expect(within(preview).getByRole("button", { name: "Show the AI computer" })).toBeVisible();

    updateStatus({ state: "replying", run_id: "next-run" });
    expect(screen.getByText("Waiting for a work preview")).toBeVisible();
    expect(screen.queryByRole("complementary", { name: "AI computer" })).not.toBeInTheDocument();
  });

  it("hides the floating computer on request and brings it back only for the next run", async () => {
    const user = userEvent.setup();
    const view = renderSidebar(privateScope, true, <ChatComposerFixture />);
    const updateStatus = (status: AgentStatus) => act(() => {
      view.store.dispatch({
        type: "SET_AGENT_STATUS",
        payload: { mode: "private", scopeId: "7", status, authoritative: true },
      });
    });
    const preview = screen.getByRole("region", { name: "Computer preview" });

    updateStatus({ state: "replying", run_id: "run-1" });
    expect(within(preview).getByRole("button", { name: "Show the AI computer" })).toBeVisible();

    await user.click(within(preview).getByRole("button", { name: "Hide the AI computer" }));
    expect(within(preview).queryByRole("button", { name: "Show the AI computer" })).not.toBeInTheDocument();

    // Same run keeps working: stays hidden, but the header entry still opens the full computer.
    updateStatus({ state: "replying", run_id: "run-1", computer: { mode: "search", search: { tool: "web", hits: [{ title: "Later hit" }] } } });
    expect(within(preview).queryByRole("button", { name: "Show the AI computer" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show the AI computer" })).toBeVisible();

    updateStatus({ state: "replying", run_id: "run-2" });
    expect(within(preview).getByRole("button", { name: "Show the AI computer" })).toBeVisible();
  });

  it("keeps the expanded page and chat input mounted through viewport changes", async () => {
    mocks.viewportWidth = 1568;
    mocks.availability.presentAvailable = true;
    const user = userEvent.setup();
    renderSidebar(privateScope, true, <ChatComposerFixture />);
    const preview = screen.getByRole("region", { name: "Computer preview" });
    const composer = screen.getByRole("textbox", { name: "Message input" });
    const compactFrame = screen.getByTitle("Presented page");
    expect(screen.getAllByTitle("Presented page")).toEqual([compactFrame]);
    await user.type(composer, "Keep this draft");

    await user.click(within(preview).getByRole("button", { name: "Show the AI computer" }));
    const computer = await waitForOpenPreview("AI computer");
    const expandedFrame = within(computer).getByTitle("Presented page");
    expect(compactFrame.isConnected).toBe(false);
    expect(screen.getAllByTitle("Presented page")).toEqual([expandedFrame]);
    await user.click(composer);
    fireEvent.select(composer, { target: { selectionStart: 5, selectionEnd: 9 } });

    changeViewport(1120);
    expect(await waitForOpenPreview("AI computer")).toBe(computer);
    expect(screen.queryByRole("dialog", { name: "AI computer" })).not.toBeInTheDocument();
    expect(screen.getAllByTitle("Presented page")).toEqual([expandedFrame]);
    expect(screen.getByRole("textbox", { name: "Message input" })).toBe(composer);
    expect(composer).toHaveValue("Keep this draft");
    expect(composer).toHaveFocus();
    expect(composer).toHaveProperty("selectionStart", 5);
    expect(composer).toHaveProperty("selectionEnd", 9);

    changeViewport(390);
    expect(await waitForOpenPreview("AI computer")).toBe(computer);
    expect(screen.getAllByTitle("Presented page")).toEqual([expandedFrame]);
    changeViewport(1568);
    expect(await waitForOpenPreview("AI computer")).toBe(computer);
    expect(screen.getAllByTitle("Presented page")).toEqual([expandedFrame]);

    await user.click(within(computer).getByRole("button", { name: "Minimize the AI computer" }));
    await waitForClosedPreview();
    expect(expandedFrame.isConnected).toBe(false);
    expect(screen.getAllByTitle("Presented page")).toHaveLength(1);
    expect(within(preview).getByRole("button", { name: "Show the AI computer" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Message input" })).toBe(composer);
    expect(composer).toHaveValue("Keep this draft");

    changeViewport(1120);
    await user.click(within(preview).getByRole("button", { name: "Show the AI computer" }));
    const reopened = await waitForOpenPreview("AI computer");
    const reopenedFrame = within(reopened).getByTitle("Presented page");
    changeViewport(1568);
    expect(await waitForOpenPreview("AI computer")).toBe(reopened);
    expect(screen.getAllByTitle("Presented page")).toEqual([reopenedFrame]);
  });

  it("opens Agent-scoped Skill management for private and channel chats", async () => {
    const view = renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "Open Skill manager" }));

    await waitForOpenPreview("Skills");
    expect(await screen.findByTestId("skills-panel-fixture")).toBeVisible();

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

  it("opens one read-only computer instead of separate browser and terminal entries", async () => {
    mocks.availability.browserActive = true;
    mocks.availability.runningTerminalCount = 2;
    renderSidebar();

    const computerButton = screen.getByRole("button", { name: "Show the AI computer" });
    expect(screen.queryByRole("button", { name: "Open browser preview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open terminal preview/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open scheduled tasks" })).toBeVisible();

    await userEvent.click(computerButton);

    expect(computerButton).toHaveAttribute("aria-expanded", "true");
    const computer = await waitForOpenPreview("AI computer");
    expect(within(computer).getByRole("img", { name: "Latest Agent browser frame" })).toBeVisible();
    expect(within(computer).getByRole("button", { name: "Take control" })).toBeVisible();
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it("starts assistance before availability only once per explicit work-record gesture", async () => {
    const user = userEvent.setup();
    renderSidebar(privateScope, true, <BrowserAssistFixture />);

    expect(screen.queryByRole("button", { name: "Show the AI computer" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open browser from work" }));

    await waitForOpenPreview("AI computer");
    expect(await screen.findByText("Human assistance")).toBeVisible();
    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    expect(mocks.acquire).toHaveBeenLastCalledWith(privateScope, "tab-1");

    await user.click(screen.getByRole("button", { name: "Minimize the AI computer" }));
    await waitForClosedPreview();
    await waitFor(() => expect(mocks.release).toHaveBeenCalledWith(privateScope, "tab-1", "lease-1"));
    await user.click(screen.getByRole("button", { name: "Open browser from work" }));
    await waitForOpenPreview("AI computer");
    expect(await screen.findByText("Human assistance")).toBeVisible();
    expect(mocks.acquire).toHaveBeenCalledTimes(2);
  });

  it("releases work-record assistance and requires a new gesture when the scope changes", async () => {
    const user = userEvent.setup();
    const view = renderSidebar(privateScope, true, <BrowserAssistFixture />);
    await user.click(screen.getByRole("button", { name: "Open browser from work" }));
    await waitForOpenPreview("AI computer");
    expect(await screen.findByText("Human assistance")).toBeVisible();
    expect(mocks.acquire).toHaveBeenCalledTimes(1);

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
    expect(screen.queryByText("Human assistance")).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.release).toHaveBeenCalledWith(privateScope, "tab-1", "lease-1"));
    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Open browser from work" }));
    await waitForOpenPreview("AI computer");
    expect(await screen.findByText("Human assistance")).toBeVisible();
    expect(mocks.acquire).toHaveBeenCalledTimes(2);
    expect(mocks.acquire).toHaveBeenLastCalledWith({ scope_type: "channel", scope_id: "4" }, "tab-1");
  });

  it("keeps one browser consumer and assistance lease across viewport changes until close", async () => {
    mocks.viewportWidth = 1568;
    mocks.availability.browserActive = true;
    const user = userEvent.setup();
    renderSidebar(privateScope, true, <BrowserAssistFixture />);

    await user.click(screen.getByRole("button", { name: "Open browser from work" }));
    const computer = await waitForOpenPreview("AI computer");
    expect(await within(computer).findByText("Human assistance")).toBeVisible();
    const browserInput = within(computer).getByRole("application");
    const browserFrame = within(computer).getByRole("img", { name: "Latest Agent browser frame" });
    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    expect(mocks.release).not.toHaveBeenCalled();

    changeViewport(1120);
    expect(await waitForOpenPreview("AI computer")).toBe(computer);
    expect(within(computer).getByRole("application")).toBe(browserInput);
    expect(within(computer).getByRole("img", { name: "Latest Agent browser frame" })).toBe(browserFrame);
    expect(within(computer).getByText("Human assistance")).toBeVisible();
    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    expect(mocks.release).not.toHaveBeenCalled();

    changeViewport(390);
    expect(await waitForOpenPreview("AI computer")).toBe(computer);
    expect(within(computer).getByRole("application")).toBe(browserInput);
    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    expect(mocks.release).not.toHaveBeenCalled();
    changeViewport(1568);
    expect(await waitForOpenPreview("AI computer")).toBe(computer);
    expect(within(computer).getByRole("application")).toBe(browserInput);
    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    expect(mocks.release).not.toHaveBeenCalled();

    await user.click(within(computer).getByRole("button", { name: "Minimize the AI computer" }));
    await waitForClosedPreview();
    await waitFor(() => expect(mocks.release).toHaveBeenCalledTimes(1));
    expect(mocks.release).toHaveBeenCalledWith(privateScope, "tab-1", "lease-1");

    changeViewport(1120);
    await user.click(screen.getByRole("button", { name: "Show the AI computer" }));
    const reopened = await waitForOpenPreview("AI computer");
    expect(within(reopened).getByRole("button", { name: "Take control" })).toBeVisible();
    expect(within(reopened).queryByText("Human assistance")).not.toBeInTheDocument();
    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it.each([1568, 1120, 390])("keeps chat usable and scopes Escape to the nonmodal computer at width %s", async (width) => {
    mocks.viewportWidth = width;
    mocks.availability.browserActive = true;
    const user = userEvent.setup();
    const view = renderSidebar(
      privateScope,
      true,
      <textarea data-composer-input aria-label="Message input" />,
    );
    const computerButton = screen.getByRole("button", { name: "Show the AI computer" });
    const composer = screen.getByRole("textbox", { name: "Message input" });

    await user.click(computerButton);
    const computer = await waitForOpenPreview("AI computer");
    expect(screen.queryByRole("dialog", { name: "AI computer" })).not.toBeInTheDocument();
    await waitFor(() => expect(within(computer).getByRole("button", {
      name: "Minimize the AI computer",
    })).toHaveFocus());

    await user.click(composer);
    await user.type(composer, "Keep chatting");
    await user.keyboard("{Escape}");
    expect(composer).toHaveValue("Keep chatting");
    expect(computer).toBeVisible();
    expect(composer).toHaveFocus();

    await user.click(within(computer).getByRole("button", { name: "Take control" }));
    const browserInput = await within(computer).findByRole("application");
    browserInput.focus();
    act(() => {
      view.store.dispatch({
        type: "SET_AGENT_STATUS",
        payload: {
          mode: "private",
          scopeId: "7",
          status: { state: "replying", run_id: "new-browser-work", computer: { mode: "browser" } },
          authoritative: true,
        },
      });
    });
    expect(browserInput).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(computer).toBeVisible();
    await waitFor(() => expect(mocks.input).toHaveBeenCalledWith(
      privateScope,
      "tab-1",
      "lease-1",
      1,
      { action: "key", key: "Escape" },
    ));

    const minimize = within(computer).getByRole("button", { name: "Minimize the AI computer" });
    minimize.focus();
    await user.keyboard("{Escape}");
    await waitForClosedPreview();
    await waitFor(() => expect(computerButton).toHaveFocus());
  });


  it.each([1440, 390])("returns focus to the composer when a PiP opener unmounts at width %s", async (width) => {
    mocks.viewportWidth = width;
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
      <ChatComposerFixture />,
      state,
    );
    const composer = screen.getByRole("textbox", { name: "Message input" });
    const pipButton = within(screen.getByRole("region", { name: "Computer preview" }))
      .getByRole("button", { name: "Show the AI computer" });
    expect(pipButton).toBeVisible();

    await user.click(pipButton);

    expect(pipButton.isConnected).toBe(false);
    const computer = await waitForOpenPreview("AI computer");
    await waitFor(() => expect(computer.contains(document.activeElement)).toBe(true));
    await user.keyboard("{Escape}");
    await waitForClosedPreview();

    await waitFor(() => expect(composer).toHaveFocus());
  });

  it("keeps scheduled tasks and the expanded computer mutually exclusive", async () => {
    mocks.availability.browserActive = true;
    renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "Show the AI computer" }));
    const computer = await waitForOpenPreview("AI computer");

    await userEvent.click(screen.getByRole("button", { name: "Open scheduled tasks" }));
    await waitForOpenPreview("Scheduled tasks");
    const scheduledFixture = await screen.findByTestId("scheduled-tasks-fixture");
    expect(scheduledFixture).toBeVisible();
    expect(computer.isConnected).toBe(false);
    expect(screen.queryByRole("img", { name: "Latest Agent browser frame" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Close preview" }));
    await waitForClosedPreview();
    await userEvent.click(screen.getByRole("button", { name: "Show the AI computer" }));
    await waitForOpenPreview("AI computer");
    expect(screen.queryByTestId("scheduled-tasks-fixture")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Latest Agent browser frame" })).toBeVisible();
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

  it("resets an expanded computer to the new scope's compact content and does not reopen on return", async () => {
    const privateStatus: AgentStatus = {
      state: "replying",
      run_id: "private-run",
      computer: { mode: "search", search: { tool: "web", hits: [{ title: "Private result" }] } },
    };
    const channelStatus: AgentStatus = {
      state: "replying",
      run_id: "channel-run",
      computer: { mode: "search", search: { tool: "web", hits: [{ title: "Channel result" }] } },
    };
    const view = renderSidebar(privateScope, true, <ChatComposerFixture />, {
      ...initialAppState,
      agentStatuses: {
        ...initialAppState.agentStatuses,
        private: privateStatus,
        channels: { "4": channelStatus },
      },
    });
    await userEvent.click(within(screen.getByRole("region", { name: "Computer preview" }))
      .getByRole("button", { name: "Show the AI computer" }));
    const computer = await waitForOpenPreview("AI computer");
    expect(within(computer).getByText("Private result")).toBeVisible();

    view.rerender(
      <StoreContext.Provider value={view.store}>
        <TestUiProviders>
          <ChatPreviewSidebar scope={{ scope_type: "channel", scope_id: "4" }}>
            <PreviewHeaderFixture />
            <ChatComposerFixture />
          </ChatPreviewSidebar>
        </TestUiProviders>
      </StoreContext.Provider>,
    );

    expect(computer.isConnected).toBe(false);
    await waitForClosedPreview();
    expect(screen.queryByText("Private result")).not.toBeInTheDocument();
    expect(screen.getByText("Channel result")).toBeVisible();
    expect(within(screen.getByRole("region", { name: "Computer preview" }))
      .getByRole("button", { name: "Show the AI computer" })).toBeVisible();

    view.rerender(
      <StoreContext.Provider value={view.store}>
        <TestUiProviders>
          <ChatPreviewSidebar scope={privateScope}>
            <PreviewHeaderFixture />
            <ChatComposerFixture />
          </ChatPreviewSidebar>
        </TestUiProviders>
      </StoreContext.Provider>,
    );
    expect(screen.getByText("Private result")).toBeVisible();
    expect(screen.queryByText("Channel result")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "AI computer" })).not.toBeInTheDocument();
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
