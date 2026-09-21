// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeContext } from "../../context/ThemeContext";
import { ToastProvider } from "../../context/ToastContext";
import { navigateToView } from "../../data/chatActions";
import { endpoints } from "../../lib/endpoints";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
import type { AppState, User } from "../../types";
import { BeautifulProvider } from "../ui/BeautifulProvider";
import { PublicUtilities } from "../ui/PublicUtilities";
import { AppShell } from "./AppShell";
import { ChannelCreateForm } from "./ChannelCreateForm";
import { UserMenu } from "./UserMenu";

vi.mock("../../hooks/useRealtime", () => ({ useRealtime: () => true }));
vi.mock("../../hooks/usePolling", () => ({ usePolling: () => undefined }));
vi.mock("../../data/accountActions", () => ({
  ensureCurrentUserTimezone: () => Promise.resolve(),
}));

const currentUser: User = {
  id: 7,
  username: "avery",
  display_name: "Avery Chen",
  position: "Engineer",
  role: "admin",
  permission_group: "admin",
  permissions: [
    "read_workspace",
    "chat",
    "private_agent",
    "manage_channels",
    "manage_users",
    "system_settings",
  ],
};

function renderShell(ui: React.ReactNode, overrides: Partial<AppState> = {}) {
  const store = createStore(rootReducer, {
    ...initialAppState,
    user: currentUser,
    ...overrides,
  });
  const toggleTheme = vi.fn();
  const view = render(
    <StoreContext.Provider value={store}>
      <I18nProvider>
        <ThemeContext.Provider value={{ theme: "light", toggleTheme }}>
          <BeautifulProvider><ToastProvider>{ui}</ToastProvider></BeautifulProvider>
        </ThemeContext.Provider>
      </I18nProvider>
    </StoreContext.Provider>,
  );
  return { store, toggleTheme, ...view };
}

describe("application shell controls", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query === "(prefers-reduced-motion: reduce)"
          || query === "(max-width: 1039px)"
          || query === "(max-width: 1040px)"
          || query === "(max-width: 1040px), (pointer: coarse)",
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

  it("keeps account actions and independent theme and locale controls available", async () => {
    const user = userEvent.setup();
    const { toggleTheme } = renderShell(<><UserMenu /><PublicUtilities /></>);

    const trigger = screen.getByRole("button", { name: "Open user menu" });
    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeVisible());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));

    await user.click(screen.getByRole("button", { name: "Dark theme" }));
    expect(toggleTheme).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("combobox", { name: "Language" }));
    await user.click(screen.getByText("繁體中文"));
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("zh-TW");
  });

  it("does not use a permission group as the identity subtitle", async () => {
    const user = userEvent.setup();
    renderShell(<UserMenu />, {
      user: { ...currentUser, position: "" },
    });

    expect(screen.getByText("Avery Chen")).toBeVisible();
    expect(screen.getByText("@avery")).toBeVisible();
    expect(screen.queryByText("Engineer")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open user menu" }));
    expect(screen.queryByText("Administrator")).not.toBeInTheDocument();
  });

  it("opens and dismisses one focus-managed mobile navigation drawer", async () => {
    const user = userEvent.setup();
    renderShell(<AppShell />);

    const trigger = screen.getByRole("button", { name: "Open menu" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(trigger);

    const drawer = await screen.findByRole("dialog");
    expect(drawer).toBeVisible();
    expect(within(drawer).getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("dismisses mobile navigation and restores focus after programmatic scope navigation", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
      const payload = url.pathname === endpoints.privateMessages.path()
        ? { messages: [], agent_status: null, next_before_id: null, has_more: false }
        : url.pathname === endpoints.privateTelegram.path()
          ? { gateway: { enabled: false }, link: null, pending: null }
          : null;
      if (!payload) throw new Error(`Unexpected request: ${url.pathname}`);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));
    const { store } = renderShell(<AppShell />, { personalAiGuideShownThisSession: true });
    const trigger = screen.getByRole("button", { name: "Open menu" });
    await user.click(trigger);
    expect(await screen.findByRole("dialog")).toBeVisible();

    await act(async () => { await navigateToView(store, "private"); });

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps the channel API payload verbatim after the whitespace guard", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = init?.method === "POST" ? {} : { channels: [] };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderShell(<ChannelCreateForm />);
    await user.click(screen.getByRole("button", { name: "Create public channel" }));
    const dialog = screen.getByRole("dialog", { name: "Create public channel" });

    await user.type(within(dialog).getByLabelText("New public channel name"), "  roadmap  ");
    await user.click(within(dialog).getByRole("button", { name: "Create public channel" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ name: "  roadmap  " }),
    });
  });
});
