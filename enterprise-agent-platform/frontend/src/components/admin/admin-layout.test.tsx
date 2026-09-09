// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeContext } from "../../context/ThemeContext";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
import type { User } from "../../types";
import { AntDesignProvider } from "../ui/AntDesignProvider";
import { AccountManagement } from "./accounts/AccountManagement";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function renderAdmin(ui: ReactNode, users: User[] = []) {
  const store = createStore(rootReducer, initialAppState);
  if (users.length) store.dispatch({ type: "SET_USERS", payload: users });

  return render(
    <StoreContext.Provider value={store}>
      <I18nProvider>
        <ThemeContext.Provider value={{ theme: "light", toggleTheme: () => {} }}>
          <AntDesignProvider>{ui}</AntDesignProvider>
        </ThemeContext.Provider>
      </I18nProvider>
    </StoreContext.Provider>,
  );
}

describe("Ant Design administration surfaces", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    const getComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => getComputedStyle(element));
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(() => false),
      })),
    });
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });


  it("renders the account page with an empty store", () => {
    renderAdmin(<AccountManagement createOpen={false} onCloseCreate={() => {}} />);

    const region = screen.getByRole("region", { name: "Accounts" });
    expect(within(region).getByText("0 accounts")).toBeInTheDocument();
    expect(within(region).getByText("No accounts yet.")).toBeInTheDocument();
  });

  it("associates every create-account label with its real control", () => {
    renderAdmin(<AccountManagement createOpen onCloseCreate={() => {}} />);

    expect(screen.getByRole("dialog", { name: "Create account" })).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByLabelText("Display name")).toBeInTheDocument();
    expect(screen.getByLabelText("Initial password")).toBeInTheDocument();
    expect(screen.getByLabelText("Position")).toBeInTheDocument();
    expect(screen.getByLabelText("Permission group")).toHaveAttribute("role", "combobox");
    expect(screen.getByLabelText("Model")).toHaveAttribute("role", "combobox");
    expect(screen.getByLabelText("Thinking depth")).toHaveAttribute("role", "combobox");
  });


  it("keeps edit-account controls labelled when the drawer is portalled", async () => {
    const user: User = {
      id: 8,
      username: "morgan",
      display_name: "Morgan Lee",
      position: "Designer",
      permission_group: "member",
      thinking_depth: "medium",
      active: true,
    };
    renderAdmin(<AccountManagement createOpen={false} onCloseCreate={() => {}} />, [user]);

    screen.getByRole("button", { name: "Edit" }).click();

    await screen.findByRole("dialog", { name: "Edit morgan" });
    expect(screen.getByLabelText("Display name")).toHaveValue("Morgan Lee");
    expect(screen.getByLabelText("Position")).toHaveValue("Designer");
    expect(screen.getByLabelText("Permission group")).toHaveAttribute("role", "combobox");
    expect(screen.getByLabelText("Account enabled")).toHaveAttribute("role", "switch");
  });

  it("preserves an unavailable explicit model when saving an unrelated identity change", async () => {
    const account: User = { id: 8, username: "morgan", display_name: "Morgan", permission_group: "member", model_name: "saved-unavailable-model", active: true };
    const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => ({
      ok: true, status: 200,
      text: async () => JSON.stringify(init?.method === "PUT" ? { user: account } : { users: [account] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    renderAdmin(<AccountManagement createOpen={false} onCloseCreate={() => {}} />, [account]);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("dialog", { name: "Edit morgan" });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Morgan Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save account" }));
    await waitFor(() => {
      const write = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
      expect(write).toBeDefined();
      expect(JSON.parse(String(write?.[1]?.body))).toMatchObject({ display_name: "Morgan Updated", model_name: "saved-unavailable-model" });
    });
  });
});
