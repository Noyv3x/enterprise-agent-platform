// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
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
import { AdminPager } from "./AdminPager";

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

  it("renders grouped navigation and the compact page switcher", () => {
    renderAdmin(<AdminPager activeId="accounts" />);

    const navigation = screen.getByRole("navigation", { name: "Administration navigation" });
    expect(within(navigation).getByText("People & data")).toBeInTheDocument();
    expect(within(navigation).getByRole("menuitem", { name: "Accounts & permissions" }))
      .toHaveClass("eap-menu-item-selected");
    expect(within(navigation).getByText("Agent runtime")).toBeInTheDocument();
    const switcher = screen.getByText("Administration page").closest(".eap-admin-page-switcher");
    expect(screen.getByRole("combobox", { name: "Administration page" })).toBeInTheDocument();
    expect(within(switcher as HTMLElement).getByText("Accounts & permissions")).toBeInTheDocument();
  });

  it("renders the account page with an empty store", () => {
    renderAdmin(<AccountManagement createOpen={false} onCloseCreate={() => {}} />);

    const region = screen.getByRole("region", { name: "Accounts" });
    expect(within(region).getByText("0 accounts")).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getByText("No accounts yet.")).toBeInTheDocument();
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

  it("renders structured account data without opening either drawer", () => {
    const user: User = {
      id: 7,
      username: "avery",
      display_name: "Avery Chen",
      position: "Engineer",
      permission_group: "manager",
      model_name: "gpt-5.3-codex",
      thinking_depth: "high",
      active: true,
    };

    renderAdmin(
      <AccountManagement createOpen={false} onCloseCreate={() => {}} />,
      [user],
    );

    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Account" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Permission" })).toBeInTheDocument();
    expect(within(table).getByText("Avery Chen")).toBeInTheDocument();
    expect(within(table).getByText("@avery · Engineer")).toBeInTheDocument();
    expect(within(table).getByText("Manager")).toBeInTheDocument();
    expect(within(table).getByText("gpt-5.3-codex")).toBeInTheDocument();
    expect(within(table).getByText("Active")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps edit-account controls labelled when the drawer is portalled", async () => {
    const user: User = {
      id: 8,
      username: "morgan",
      display_name: "Morgan Lee",
      permission_group: "member",
      thinking_depth: "medium",
      active: true,
    };
    renderAdmin(<AccountManagement createOpen={false} onCloseCreate={() => {}} />, [user]);

    screen.getByRole("button", { name: "Edit" }).click();

    expect(await screen.findByRole("dialog", { name: "Edit morgan" })).toBeInTheDocument();
    expect(screen.getByLabelText("Display name")).toHaveValue("Morgan Lee");
    expect(screen.getByLabelText("Permission group")).toHaveAttribute("role", "combobox");
    expect(screen.getByLabelText("Account enabled")).toHaveAttribute("role", "switch");
  });
});
