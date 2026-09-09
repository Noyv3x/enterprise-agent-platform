// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALE_STORAGE_KEY } from "../../i18n";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
import { TestUiProviders } from "../../test/TestUiProviders";
import { LoginView } from "./LoginView";


describe("LoginView", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function renderLogin() {
    const store = createStore(rootReducer, initialAppState);
    const view = render(
      <StoreContext.Provider value={store}>
        <TestUiProviders>
          <LoginView />
        </TestUiProviders>
      </StoreContext.Provider>,
    );
    return { store, ...view };
  }

  it("provides language selection and required credential fields", () => {
    renderLogin();
    expect(screen.getByRole("combobox", { name: "Language" })).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toBeRequired();
    expect(screen.getByLabelText("Password")).toBeRequired();
  });

  it("keeps failed authentication inline and submits the entered credentials", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      JSON.stringify({ error: "Invalid credentials" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    renderLogin();

    await user.type(screen.getByLabelText("Username"), "avery");
    await user.type(screen.getByLabelText("Password"), "secret-pass");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The username or password is incorrect.");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ username: "avery", password: "secret-pass" }),
    });
  });

  it("honors login Retry-After and blocks repeat submissions during the countdown", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: "too many attempts", code: "login_rate_limited" }),
      { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "2" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    renderLogin();

    await user.type(screen.getByLabelText("Username"), "avery");
    await user.type(screen.getByLabelText("Password"), "wrong-pass");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many sign-in attempts. Try again in 2 seconds.",
    );
    const blocked = screen.getByRole("button", { name: /Retry in 2s/ });
    expect(blocked).toBeDisabled();
    await user.click(blocked);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
