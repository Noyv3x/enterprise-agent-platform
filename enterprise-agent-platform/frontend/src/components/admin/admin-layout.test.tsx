// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeContext } from "../../context/ThemeContext";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
import type { PermissionGroup, User } from "../../types";
import { BeautifulProvider } from "../ui/BeautifulProvider";
import { AccountManagement } from "./accounts/AccountManagement";
import userEvent from "@testing-library/user-event";

function renderAdmin(ui: ReactNode, users: User[] = [], permissionGroups: PermissionGroup[] = []) {
  const store = createStore(rootReducer, initialAppState);
  if (users.length) store.dispatch({ type: "SET_USERS", payload: users });
  if (permissionGroups.length) store.dispatch({ type: "SET_PERMISSION_GROUPS", payload: permissionGroups });

  return render(
    <StoreContext.Provider value={store}>
      <I18nProvider>
        <ThemeContext.Provider value={{ theme: "light", toggleTheme: () => {} }}>
          <BeautifulProvider>{ui}</BeautifulProvider>
        </ThemeContext.Provider>
      </I18nProvider>
    </StoreContext.Provider>,
  );
}

function AccountCreationHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open account editor</button>
      <AccountManagement createOpen={open} onCloseCreate={() => setOpen(false)} />
    </>
  );
}

describe("Administration surfaces", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
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

  it("dismisses the account Select before its editor and preserves a draft when discard is cancelled", async () => {
    const user = userEvent.setup();
    renderAdmin(<AccountCreationHarness />, [], [
      { id: "member", permissions: [] },
      { id: "admin", permissions: ["admin"] },
    ]);
    const opener = screen.getByRole("button", { name: "Open account editor" });
    await user.click(opener);
    const editor = await screen.findByRole("dialog", { name: "Create account" });
    const permissionGroup = within(editor).getByRole("combobox", { name: "Permission group" });

    await user.click(permissionGroup);
    await waitFor(() => expect(permissionGroup).toHaveAttribute("aria-expanded", "true"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(permissionGroup).toHaveAttribute("aria-expanded", "false"));
    expect(screen.getAllByRole("dialog")).toEqual([editor]);
    expect(permissionGroup).toHaveFocus();

    const displayName = within(editor).getByRole("textbox", { name: "Display name" });
    await user.type(displayName, "Unsaved account");
    await user.click(permissionGroup);
    await waitFor(() => expect(permissionGroup).toHaveAttribute("aria-expanded", "true"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(permissionGroup).toHaveAttribute("aria-expanded", "false"));
    expect(screen.getAllByRole("dialog")).toEqual([editor]);
    expect(displayName).toHaveValue("Unsaved account");

    const cancelEditor = within(editor).getByRole("button", { name: "Cancel" });
    await user.click(cancelEditor);
    const confirmation = await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    await waitFor(() => expect(confirmation).toContainElement(document.activeElement as HTMLElement));
    fireEvent.keyDown(document.activeElement!, { key: "Escape", code: "Escape", keyCode: 27, which: 27 });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Discard unsaved changes?" })).not.toBeInTheDocument());
    expect(screen.getAllByRole("dialog")).toEqual([editor]);
    expect(displayName).toHaveValue("Unsaved account");
    await waitFor(() => expect(cancelEditor).toHaveFocus());

    await user.click(cancelEditor);
    const reopenedConfirmation = await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    await user.click(within(reopenedConfirmation).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
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
