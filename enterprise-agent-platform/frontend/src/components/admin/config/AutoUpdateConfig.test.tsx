// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../../i18n";
import { createStore } from "../../../lib/store";
import { initialAppState, rootReducer } from "../../../store/reducer";
import { StoreContext } from "../../../store/StoreProvider";
import type { AutoUpdateConfigState } from "../../../types";
import { AutoUpdateConfig } from "./AutoUpdateConfig";

function renderConfig(value: AutoUpdateConfigState) {
  const store = createStore(rootReducer, initialAppState);
  store.dispatch({ type: "SET_AUTO_UPDATE_CONFIG", payload: value });
  return render(
    <StoreContext.Provider value={store}>
      <I18nProvider>
        <AutoUpdateConfig />
      </I18nProvider>
    </StoreContext.Provider>,
  );
}

function metric(label: string): HTMLElement {
  return screen.getByText(label).closest(".metric-tile") as HTMLElement;
}

describe("AutoUpdateConfig live status", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("shows the queued phase and each update blocker count", () => {
    renderConfig({
      config: { enabled: true, interval_seconds: 30, remote: "origin", branch: "main" },
      status: {
        state: "waiting_for_tasks",
        active_tasks: 2,
        queued_tasks: 3,
        protected_processes: 1,
        waiting_since: 1_720_000_000,
      },
    });

    expect(within(metric("Status")).getByText("Waiting for tasks")).toBeInTheDocument();
    expect(within(metric("Active tasks")).getByText("2")).toBeInTheDocument();
    expect(within(metric("Queued tasks")).getByText("3")).toBeInTheDocument();
    expect(within(metric("Protected terminals")).getByText("1")).toBeInTheDocument();
    expect(screen.getByText(/The update is queued/)).toBeInTheDocument();
  });

  it("refreshes status while the page is visible", async () => {
    renderConfig({
      config: { enabled: true, interval_seconds: 30, remote: "origin", branch: "main" },
      status: { state: "waiting_for_tasks", active_tasks: 1 },
    });
    const remoteInput = screen.getByLabelText("Git remote");
    fireEvent.change(remoteInput, { target: { value: "work-in-progress" } });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      config: { enabled: true, interval_seconds: 30, remote: "origin", branch: "main" },
      status: {
        state: "idle",
        active_tasks: 0,
        queued_tasks: 0,
        protected_processes: 0,
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/system/auto-update/config",
      expect.objectContaining({ credentials: "include" }),
    ));
    await waitFor(() => expect(within(metric("Status")).getByText("Idle")).toBeInTheDocument());
    expect(screen.queryByText(/The update is queued/)).not.toBeInTheDocument();
    expect(remoteInput).toHaveValue("work-in-progress");
  });
});
