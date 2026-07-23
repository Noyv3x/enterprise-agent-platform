// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeContext } from "../../context/ThemeContext";
import { ToastProvider } from "../../context/ToastContext";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
import type { AppState, User } from "../../types";
import { AntDesignProvider } from "../ui/AntDesignProvider";
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
    "manage_knowledge",
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
          <AntDesignProvider><ToastProvider>{ui}</ToastProvider></AntDesignProvider>
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
        matches: query === "(max-width: 800px)",
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

  it("uses the library menu for account preferences without losing platform state", async () => {
    const user = userEvent.setup();
    const { toggleTheme } = renderShell(<UserMenu />);

    const trigger = screen.getByRole("button", { name: "Open user menu" });
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitem", { name: "Personal settings" })).toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "Dark theme" }));
    expect(toggleTheme).toHaveBeenCalledTimes(1);

    await user.click(screen.getByText("繁體中文"));
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("zh-TW");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
  });

  it("opens and dismisses one focus-managed mobile navigation drawer", async () => {
    const user = userEvent.setup();
    const { store } = renderShell(<AppShell />);

    const trigger = screen.getByRole("button", { name: "Open menu" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(trigger);

    expect(await screen.findByRole("dialog")).toBeVisible();
    expect(screen.getAllByRole("navigation", { name: "Main navigation" })).toHaveLength(1);
    expect(store.getState().sidebarOpen).toBe(true);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(store.getState().sidebarOpen).toBe(false));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
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

    await user.type(screen.getByLabelText("New channel name"), "  roadmap  ");
    await user.click(screen.getByRole("button", { name: "Create channel" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ name: "  roadmap  " }),
    });
  });
});
