// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      <I18nProvider><AutoUpdateConfig /></I18nProvider>
    </StoreContext.Provider>,
  );
}

describe("AutoUpdateConfig manager state", () => {
  beforeEach(() => window.localStorage.setItem(LOCALE_STORAGE_KEY, "en"));

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("shows queued work and immutable generations without Git worktree controls", () => {
    renderConfig({
      config: {
        enabled: true,
        interval_seconds: 300,
        release_manifest_url: "https://releases.example/main.json",
        release_channel: "main",
      },
      status: {
        state: "waiting_for_tasks",
        phase: "pulling",
        manager_generation: 17,
        active_tasks: 2,
        queued_tasks: 3,
        current_generation: "generation-current-123",
        target_generation: "generation-target-456",
        previous_generation: "generation-previous-789",
        operation_id: "operation-1",
      },
    });

    expect(screen.getByText("Waiting for tasks")).toBeInTheDocument();
    expect(screen.getByText(/The update is queued/)).toBeInTheDocument();
    expect(screen.getByText("generation-current")).toBeInTheDocument();
    expect(screen.getByText("operation-1")).toBeInTheDocument();
    expect(screen.queryByText("Git remote")).not.toBeInTheDocument();
  });

  it("uses the numeric manager generation for optimistic concurrency", async () => {
    renderConfig({
      config: {
        enabled: true,
        interval_seconds: 300,
        release_manifest_url: "https://releases.example/main.json",
        release_channel: "main",
      },
      status: {
        state: "idle",
        manager_generation: 23,
        update_available: true,
        current_generation: "release-current",
        target_generation: "release-target",
      },
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      config: { enabled: true, interval_seconds: 300 },
      status: { state: "idle", manager_generation: 24 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    fireEvent.click(screen.getByRole("button", { name: "Update now" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/system/auto-update/operations/update",
      expect.objectContaining({ body: JSON.stringify({ expected_generation: 23 }) }),
    ));
  });

  it("refreshes manager status without overwriting an in-progress form draft", async () => {
    renderConfig({
      config: {
        enabled: true,
        interval_seconds: 300,
        release_manifest_url: "https://releases.example/main.json",
        release_channel: "main",
      },
      status: { state: "waiting_for_tasks", active_tasks: 1 },
    });
    const manifestInput = screen.getByDisplayValue("https://releases.example/main.json");
    fireEvent.change(manifestInput, { target: { value: "https://draft.example/main.json" } });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      config: {
        enabled: true,
        interval_seconds: 300,
        release_manifest_url: "https://releases.example/main.json",
        release_channel: "main",
      },
      status: { state: "idle", active_tasks: 0, queued_tasks: 0 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/system/auto-update/config",
      expect.objectContaining({ credentials: "include" }),
    ));
    await waitFor(() => expect(screen.getByText("Idle")).toBeInTheDocument());
    expect(manifestInput).toHaveValue("https://draft.example/main.json");
  });
});
