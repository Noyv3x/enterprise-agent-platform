// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALE_STORAGE_KEY } from "../../../i18n";
import { saveBrandingConfig } from "../../../data/adminActions";
import { createStore } from "../../../lib/store";
import { initialAppState, rootReducer } from "../../../store/reducer";
import { StoreContext } from "../../../store/StoreProvider";
import { TestUiProviders } from "../../../test/TestUiProviders";
import type { BrandingSnapshot } from "../../../types";
import { BrandingSettings, brandingLogoPayload } from "./BrandingSettings";

const current: BrandingSnapshot = {
  schema_version: 1,
  revision: 4,
  product_name: "Current Product",
  agent_name: "Current Agent",
  primary_color: "#123456",
  logo_url: null,
};

describe("BrandingSettings", () => {
  beforeEach(() => window.localStorage.setItem(LOCALE_STORAGE_KEY, "en"));

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("saves the current revision and normalized branding fields", async () => {
    const store = createStore(rootReducer, initialAppState);
    store.dispatch({ type: "SET_BRANDING_CONFIG", payload: current });
    const saved: BrandingSnapshot = {
      ...current,
      revision: 5,
      product_name: "Northstar",
      agent_name: "Navigator",
      primary_color: "#abcdef",
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(saved), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <StoreContext.Provider value={store}>
        <TestUiProviders><BrandingSettings /></TestUiProviders>
      </StoreContext.Provider>,
    );

    fireEvent.change(screen.getByLabelText("Product name"), { target: { value: " Northstar " } });
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Navigator" } });
    fireEvent.change(screen.getByLabelText("Primary color"), { target: { value: "#ABCDEF" } });
    fireEvent.click(screen.getByRole("button", { name: "Save branding" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/system/branding/config",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          expected_revision: 4,
          product_name: "Northstar",
          agent_name: "Navigator",
          primary_color: "#abcdef",
        }),
      }),
    ));
    await waitFor(() => expect(store.getState().brandingConfig).toEqual(saved));
  });

  it("encodes supported logos and rejects unsupported or oversized files before upload", async () => {
    const bytes = Uint8Array.from([0, 1, 2, 3]);
    const png = {
      type: "image/png",
      size: bytes.byteLength,
      arrayBuffer: async () => bytes.buffer,
    } as File;
    await expect(brandingLogoPayload(png)).resolves.toEqual({
      mime_type: "image/png",
      data_base64: "AAECAw==",
    });
    await expect(brandingLogoPayload({ type: "image/svg+xml", size: 10 } as File))
      .rejects.toThrow("unsupported_type");
    await expect(brandingLogoPayload({ type: "image/webp", size: 256 * 1024 + 1 } as File))
      .rejects.toThrow("invalid_size");
  });

  it("refreshes both the admin Store and Branding Context callback after a revision conflict", async () => {
    const store = createStore(rootReducer, initialAppState);
    store.dispatch({ type: "SET_BRANDING_CONFIG", payload: current });
    const authoritative: BrandingSnapshot = {
      ...current,
      revision: 9,
      product_name: "Server Authoritative",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/system/branding/config" && init?.method === "PUT") {
        return new Response(JSON.stringify({ error: "branding revision conflict" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(authoritative), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onApplied = vi.fn();

    await saveBrandingConfig(store, {
      expected_revision: 4,
      product_name: "Conflicting change",
      agent_name: "Current Agent",
      primary_color: "#123456",
    }, onApplied);

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/system/branding/config",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(store.getState().brandingConfig).toEqual(authoritative);
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onApplied).toHaveBeenCalledWith(authoritative);
  });
});
