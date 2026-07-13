// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
import { LoginView } from "./LoginView";

describe("LoginView", () => {
  beforeEach(() => window.localStorage.setItem(LOCALE_STORAGE_KEY, "en"));
  afterEach(cleanup);

  it("keeps the original split-screen layout with locale controls in the form pane", () => {
    const store = createStore(rootReducer, initialAppState);
    const { container } = render(
      <StoreContext.Provider value={store}>
        <I18nProvider>
          <LoginView />
        </I18nProvider>
      </StoreContext.Provider>,
    );

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
});
