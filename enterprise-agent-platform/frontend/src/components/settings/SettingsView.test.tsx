// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
import type { User } from "../../types";
import { SettingsView } from "./SettingsView";

const accountActions = vi.hoisted(() => ({
  changePassword: vi.fn(),
  updateCurrentUser: vi.fn(),
}));

vi.mock("../../data/accountActions", () => accountActions);

const user: User = {
  id: 7,
  username: "alice",
  display_name: "Alice",
  position: "Engineer",
  permission_group: "member",
};

describe("SettingsView dirty forms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(cleanup);

  it("enables profile save only while editable profile fields differ", async () => {
    const userEventApi = userEvent.setup();
    const store = createStore(rootReducer, initialAppState);
    store.dispatch({ type: "SET_USER", payload: user });

    render(
      <StoreContext.Provider value={store}>
        <I18nProvider>
          <SettingsView />
        </I18nProvider>
      </StoreContext.Provider>,
    );

    const displayName = screen.getByRole("textbox", { name: "Display name" });
    const save = screen.getByRole("button", { name: "Save profile" });
    expect(save).toBeDisabled();

    await userEventApi.clear(displayName);
    await userEventApi.type(displayName, "Alice Chen");
    expect(save).toBeEnabled();

    await userEventApi.clear(displayName);
    await userEventApi.type(displayName, "Alice");
    expect(save).toBeDisabled();
    expect(accountActions.updateCurrentUser).not.toHaveBeenCalled();
  });

  it("tracks password dirty state and blocks a mismatched confirmation", async () => {
    const userEventApi = userEvent.setup();
    const store = createStore(rootReducer, initialAppState);
    store.dispatch({ type: "SET_USER", payload: user });

    render(
      <StoreContext.Provider value={store}>
        <I18nProvider>
          <SettingsView />
        </I18nProvider>
      </StoreContext.Provider>,
    );

    const update = screen.getByRole("button", { name: "Update password" });
    expect(update).toBeDisabled();

    await userEventApi.type(screen.getByLabelText("Current password"), "old-password");
    await userEventApi.type(screen.getByLabelText("New password"), "new-password");
    await userEventApi.type(screen.getByLabelText("Confirm new password"), "different-password");
    expect(update).toBeEnabled();
    await userEventApi.click(update);

    expect(screen.getByRole("alert")).toHaveTextContent("The new passwords do not match");
    expect(accountActions.changePassword).not.toHaveBeenCalled();
  });
});
