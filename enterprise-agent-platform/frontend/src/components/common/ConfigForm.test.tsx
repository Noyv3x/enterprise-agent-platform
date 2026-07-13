// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
import { ConfigForm } from "./ConfigForm";

describe("ConfigForm operation state", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(cleanup);

  it("enables save only for changed fields and tracks its own operation", async () => {
    const user = userEvent.setup();
    const store = createStore(rootReducer, initialAppState);
    const onSubmit = vi.fn();

    render(
      <StoreContext.Provider value={store}>
        <I18nProvider>
          <ConfigForm
            fields={[{ key: "example", label: "Example", value: "initial", configured: true }]}
            attr="yamlKey"
            buttonText="Save fields"
            operationKey="admin:cognee:fields:save"
            onSubmit={onSubmit}
          />
        </I18nProvider>
      </StoreContext.Provider>,
    );

    const input = screen.getByRole("textbox", { name: /Example/ });
    const save = screen.getByRole("button", { name: "Save fields" });
    expect(save).toBeDisabled();

    await user.type(input, " changed");
    expect(save).toBeEnabled();

    act(() => store.dispatch({ type: "BEGIN_BUSY", payload: "unrelated" }));
    expect(save).toBeEnabled();

    act(() => store.dispatch({ type: "BEGIN_BUSY", payload: "admin:cognee:fields:save" }));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();

    act(() => store.dispatch({ type: "END_BUSY", payload: "admin:cognee:fields:save" }));
    await user.clear(input);
    await user.type(input, "initial");
    expect(screen.getByRole("button", { name: "Save fields" })).toBeDisabled();
  });
});
