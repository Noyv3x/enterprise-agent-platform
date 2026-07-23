// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

  it("keeps the original split-screen layout with locale controls in the form pane", () => {
    const { container } = renderLogin();

    const page = container.querySelector("main.auth--login");
    expect(page).toBeInTheDocument();

    const aside = page?.querySelector(".auth__aside");
    expect(aside).toBeInTheDocument();
    expect(within(aside as HTMLElement).getByRole("img", { name: "ubitech" })).toBeInTheDocument();

    const card = page?.querySelector(".auth__card");
    expect(card).toContainElement(screen.getByRole("combobox", { name: "Language" }));
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

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid credentials");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ username: "avery", password: "secret-pass" }),
    });
  });
});
