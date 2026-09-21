// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeContext } from "../../context/ThemeContext";
import { ToastProvider } from "../../context/ToastContext";
import { resourceKeys } from "../../data/resourceState";
import { I18nProvider, LOCALE_STORAGE_KEY, translate } from "../../i18n";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
import type { AppState, Message, User } from "../../types";
import { AntDesignProvider } from "../ui/AntDesignProvider";
import { AppShell } from "./AppShell";
import { PersonalAiGuideDialog } from "./PersonalAiGuideDialog";

vi.mock("../../hooks/useRealtime", () => ({ useRealtime: () => true }));
vi.mock("../../hooks/usePolling", () => ({ usePolling: () => undefined }));
vi.mock("../../data/accountActions", () => ({
  ensureCurrentUserTimezone: () => Promise.resolve(),
}));
vi.mock("../common/Dialog", async () => {
  const { useEffect } = await import("react");
  return {
    Dialog: ({
      open,
      title,
      children,
      footer,
      afterOpenChange,
    }: {
      open: boolean;
      title: React.ReactNode;
      children: React.ReactNode;
      footer?: React.ReactNode;
      afterOpenChange?: (open: boolean) => void;
    }) => {
      useEffect(() => afterOpenChange?.(open), [afterOpenChange, open]);
      return open ? (
        <div role="dialog" aria-label={typeof title === "string" ? title : undefined}>
          {children}
          {footer}
        </div>
      ) : null;
    },
  };
});

const currentUser: User = {
  id: 7,
  username: "avery",
  display_name: "Avery Chen",
  permissions: ["read_workspace", "chat", "private_agent"],
};

const readyHistory = {
  nextBeforeId: null,
  hasMore: false,
  loading: false,
  error: "",
  prependVersion: 0,
};

function renderShell(overrides: Partial<AppState> = {}, ui: React.ReactNode = <AppShell />) {
  const store = createStore(rootReducer, {
    ...initialAppState,
    user: currentUser,
    activeView: "private",
    messageHistory: { "private:7": readyHistory },
    resourceStates: {
      [resourceKeys.privateChat]: { status: "ready", error: "", updatedAt: 1 },
    },
    ...overrides,
  });
  const view = render(
    <StoreContext.Provider value={store}>
      <I18nProvider>
        <ThemeContext.Provider value={{ theme: "light", toggleTheme: vi.fn() }}>
          <AntDesignProvider>
            <ToastProvider>{ui}</ToastProvider>
          </AntDesignProvider>
        </ThemeContext.Provider>
      </I18nProvider>
    </StoreContext.Provider>,
  );
  return { store, ...view };
}

async function visibleGuide() {
  const dialog = await screen.findByRole("dialog", { name: translate("en", "personalAi.guide.title") });
  expect(dialog).toBeVisible();
  return dialog;
}

describe("Personal AI onboarding and public-channel cues", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query === "(prefers-reduced-motion: reduce)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(() => false),
      })),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("opens once for an authoritative empty Personal AI conversation", async () => {
    const { store } = renderShell({}, <PersonalAiGuideDialog onDraftFilled={vi.fn()} />);

    await visibleGuide();
    expect(screen.getAllByRole("button", { name: /^Try:/ })).toHaveLength(3);
    expect(store.getState().personalAiGuideShownThisSession).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: translate("en", "personalAi.guide.title") })).not.toBeInTheDocument());

    act(() => { store.dispatch({ type: "SET_ACTIVE_VIEW", payload: "channel" }); });
    act(() => { store.dispatch({ type: "SET_ACTIVE_VIEW", payload: "private" }); });
    expect(screen.queryByRole("dialog", { name: translate("en", "personalAi.guide.title") })).not.toBeInTheDocument();

    act(() => { store.dispatch({ type: "RESET_SESSION" }); });
    expect(store.getState().personalAiGuideOpen).toBe(false);
    expect(store.getState().personalAiGuideShownThisSession).toBe(false);
  });

  it("fills an empty draft locally, closes, and focuses without sending", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { store } = renderShell();

    await visibleGuide();
    await user.click(screen.getByRole("button", { name: "Try: Create and deliver files" }));

    expect(store.getState().drafts["private:7"]).toContain("Excel task plan");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: translate("en", "personalAi.guide.title") })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message input" })).toHaveFocus());
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  it("preserves a non-empty draft and explains why the example was not inserted", async () => {
    const user = userEvent.setup();
    const { store } = renderShell({ drafts: { "private:7": "keep my draft" } });

    await visibleGuide();
    await user.click(screen.getByRole("button", { name: "Try: Browse and operate websites" }));

    expect(store.getState().drafts["private:7"]).toBe("keep my draft");
    expect(screen.getByText(/composer already has text or attachments/)).toBeVisible();
    expect(screen.getByRole("dialog", { name: translate("en", "personalAi.guide.title") })).toBeVisible();
  });

  it("preserves attached files when the text draft is empty", async () => {
    const user = userEvent.setup();
    const attachment = new File(["existing"], "existing.txt", { type: "text/plain" });
    const { store } = renderShell({ draftFiles: { "private:7": [attachment] } });

    await visibleGuide();
    await user.click(screen.getByRole("button", { name: "Try: Browse and operate websites" }));

    expect(store.getState().drafts["private:7"] || "").toBe("");
    expect(store.getState().draftFiles["private:7"]).toEqual([attachment]);
    expect(screen.getByText(/composer already has text or attachments/)).toBeVisible();
    expect(screen.getByRole("dialog", { name: translate("en", "personalAi.guide.title") })).toBeVisible();
  });

  it.each([
    ["history is not authoritative yet", { messageHistory: {} }],
    ["the private resource is loading", {
      resourceStates: {
        [resourceKeys.privateChat]: { status: "loading" as const, error: "", updatedAt: null },
      },
    }],
    ["a durable message exists", {
      privateMessages: [{ id: 1, author_type: "user", content: "hello" } as Message],
    }],
    ["an optimistic private message exists", {
      pendingMessages: [{
        id: "tmp-1",
        scope_type: "private" as const,
        scope_id: "7",
        author_type: "user",
        content: "pending",
      } as Message],
    }],
    ["the Personal AI is active", {
      agentStatuses: { channels: {}, private: { state: "replying" as const } },
    }],
  ])("does not auto-open while %s", async (_label, overrides) => {
    renderShell(overrides as Partial<AppState>);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: translate("en", "personalAi.guide.title") })).not.toBeInTheDocument();
    });
  });

  it("keeps the guide in the sidebar and labels public channels conspicuously", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      messages: [],
      agent_status: null,
      next_before_id: null,
      has_more: false,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { store } = renderShell({
      activeView: "channel",
      activeChannelId: 3,
      channels: [{ id: 3, name: "general", description: "Team planning notes" }],
      privateMessages: [{ id: 2, author_type: "agent", content: "existing" }],
      personalAiGuideShownThisSession: true,
    });

    const navigation = screen.getByRole("navigation", { name: "Main navigation" });
    expect(within(navigation).getByText("Public channels")).toBeVisible();
    expect(within(navigation).getByText("Visible to workspace members")).toBeVisible();
    expect(within(navigation).getByText("Team planning notes")).toBeVisible();
    expect(within(screen.getByRole("main")).getByText("Public")).toBeVisible();

    await user.click(within(navigation).getByRole("button", { name: "Personal AI guide" }));
    expect(store.getState().activeView).toBe("private");
    await visibleGuide();
  });
});
