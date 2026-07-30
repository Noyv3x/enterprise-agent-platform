// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../../i18n";
import { createStore } from "../../../lib/store";
import { initialAppState, rootReducer } from "../../../store/reducer";
import { StoreContext } from "../../../store/StoreProvider";
import { LANAccessSettings } from "./LANAccessSettings";

describe("LANAccessSettings", () => {
  beforeEach(() => window.localStorage.setItem(LOCALE_STORAGE_KEY, "en"));

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("shows the plaintext warning and saves structured CIDRs", async () => {
    const store = createStore(rootReducer, initialAppState);
    store.dispatch({
      type: "SET_AUTO_UPDATE_CONFIG",
      payload: {
        config: {
          lan_enabled: false,
          lan_listen: "127.0.0.1:8081",
          direct_access_cidrs: ["192.168.0.0/16"],
          trusted_ingress_cidrs: ["127.0.0.0/8"],
          lan_active: false,
        },
        status: { state: "idle" },
      },
    });
    render(
      <StoreContext.Provider value={store}>
        <I18nProvider><LANAccessSettings /></I18nProvider>
      </StoreContext.Provider>,
    );
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      config: {
        lan_enabled: true,
        lan_listen: "127.0.0.1:8081",
        direct_access_cidrs: ["192.168.0.0/16", "10.0.0.0/8"],
        trusted_ingress_cidrs: ["127.0.0.0/8"],
        lan_active: true,
      },
      status: { state: "idle" },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    fireEvent.click(screen.getByRole("switch", { name: /Enable the separate LAN listener/ }));
    expect(screen.getByText(/Direct HTTP access may disable/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Allowed direct-access CIDRs"), {
      target: { value: "192.168.0.0/16\n10.0.0.0/8" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save LAN settings" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/system/auto-update/config",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          lan_enabled: true,
          lan_listen: "127.0.0.1:8081",
          direct_access_cidrs: ["192.168.0.0/16", "10.0.0.0/8"],
          trusted_ingress_cidrs: ["127.0.0.0/8"],
        }),
      }),
    ));
  });

  it("surfaces a bind failure without implying the primary gateway failed", () => {
    const store = createStore(rootReducer, initialAppState);
    store.dispatch({
      type: "SET_AUTO_UPDATE_CONFIG",
      payload: {
        config: { lan_enabled: true, lan_active: false, lan_error: "LAN listener is unavailable" },
        status: { state: "idle" },
      },
    });
    render(
      <StoreContext.Provider value={store}>
        <I18nProvider><LANAccessSettings /></I18nProvider>
      </StoreContext.Provider>,
    );
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByText(/primary gateway is still running/)).toBeInTheDocument();
  });
});
