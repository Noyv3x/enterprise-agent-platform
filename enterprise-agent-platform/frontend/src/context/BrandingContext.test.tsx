// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Brand } from "../components/common/Brand";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../i18n";
import type { BrandingSnapshot } from "../types";
import {
  BRANDING_CACHE_KEY,
  BrandingProvider,
  DEFAULT_BRANDING,
  fetchPublicBranding,
  isValidBrandingName,
  normalizeBrandingSnapshot,
  parseBrandingCache,
  useBranding,
} from "./BrandingContext";

function snapshot(overrides: Partial<BrandingSnapshot> = {}): BrandingSnapshot {
  const revision = overrides.revision ?? 7;
  return {
    schema_version: 1,
    revision,
    product_name: "Northstar",
    agent_name: "Navigator",
    primary_color: "#123ABC",
    logo_url: `/api/platform/branding/logo?v=${revision}`,
    ...overrides,
  };
}

function BrandingProbe({ apply }: { apply?: BrandingSnapshot }) {
  const { branding, applyBranding } = useBranding();
  return (
    <div>
      <output data-testid="branding-state">{branding.revision}:{branding.product_name}</output>
      {apply ? <button onClick={() => applyBranding(apply)}>Apply branding</button> : null}
    </div>
  );
}

describe("deployment branding", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    document.title = "";
    const meta = document.createElement("meta");
    meta.name = "description";
    document.head.append(meta);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.querySelectorAll('meta[name="description"]').forEach((node) => node.remove());
    document.documentElement.style.removeProperty("--deployment-brand");
    window.localStorage.clear();
  });

  it("accepts only the current schema, safe names, color, and same-origin versioned logo", () => {
    expect(normalizeBrandingSnapshot(snapshot(), "https://agent.example")).toEqual({
      ...snapshot(),
      primary_color: "#123abc",
    });
    expect(normalizeBrandingSnapshot(
      snapshot({ logo_url: "https://other.example/api/platform/branding/logo?v=7" }),
      "https://agent.example",
    )).toBe(DEFAULT_BRANDING);
    expect(normalizeBrandingSnapshot(snapshot({ primary_color: "red" }))).toBe(DEFAULT_BRANDING);
    expect(normalizeBrandingSnapshot(snapshot({ product_name: "unsafe\u2028name" }))).toBe(DEFAULT_BRANDING);
    expect(normalizeBrandingSnapshot({ ...snapshot(), schema_version: 2 })).toBe(DEFAULT_BRANDING);

    expect(isValidBrandingName("😀".repeat(64))).toBe(true);
    expect(isValidBrandingName("😀".repeat(65))).toBe(false);
    expect(isValidBrandingName("line\u2029break")).toBe(false);
    expect(isValidBrandingName("control\u0000character")).toBe(false);
  });

  it("rejects malformed cached snapshots instead of exposing stale deployment text", () => {
    expect(parseBrandingCache(JSON.stringify({
      snapshot: snapshot({ agent_name: "bad\u2028name" }),
      etag: '"branding-7"',
    }))).toBeNull();
    expect(parseBrandingCache("not json")).toBeNull();
    expect(parseBrandingCache(JSON.stringify({
      snapshot: snapshot(),
      etag: '"branding-6"',
    }))).toEqual({ snapshot: { ...snapshot(), primary_color: "#123abc" } });
  });

  it("renders the validated cache immediately, then revalidates metadata and theme with ETag", async () => {
    const cached = snapshot({ revision: 4, logo_url: null, product_name: "Cached Product" });
    window.localStorage.setItem(BRANDING_CACHE_KEY, JSON.stringify({
      snapshot: cached,
      etag: '"branding-4"',
    }));

    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <I18nProvider>
        <BrandingProvider><Brand /></BrandingProvider>
      </I18nProvider>,
    );

    expect(screen.getByText("Cached Product")).toBeVisible();
    expect(document.title).toBe("Cached Product");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/platform/branding",
      expect.objectContaining({ method: "GET", credentials: "include", cache: "no-cache" }),
    );
    const requestHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(requestHeaders.get("If-None-Match")).toBe('"branding-4"');

    const fresh = snapshot();
    resolveFetch(new Response(JSON.stringify(fresh), {
      status: 200,
      headers: { "Content-Type": "application/json", ETag: '"branding-7"' },
    }));

    expect(await screen.findByRole("img", { name: "Northstar" })).toHaveAttribute(
      "src",
      "/api/platform/branding/logo?v=7",
    );
    await waitFor(() => expect(document.title).toBe("Northstar"));
    expect(document.querySelector('meta[name="description"]')).toHaveAttribute(
      "content",
      expect.stringContaining("Northstar"),
    );
    expect(document.documentElement.style.getPropertyValue("--deployment-brand")).toBe("#123abc");
    expect(JSON.parse(window.localStorage.getItem(BRANDING_CACHE_KEY) || "{}")).toMatchObject({
      snapshot: { product_name: "Northstar", primary_color: "#123abc" },
      etag: '"branding-7"',
    });
  });

  it("keeps an admin save and its cache ahead of an older fetch", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);
    const saved = snapshot({ revision: 8, product_name: "Saved Eight", logo_url: null });

    render(
      <I18nProvider>
        <BrandingProvider><BrandingProbe apply={saved} /></BrandingProvider>
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply branding" }));
    expect(screen.getByTestId("branding-state")).toHaveTextContent("8:Saved Eight");

    await act(async () => {
      resolveFetch(new Response(JSON.stringify(snapshot({ revision: 7 })), {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: '"branding-7"' },
      }));
    });
    expect(screen.getByTestId("branding-state")).toHaveTextContent("8:Saved Eight");
    expect(JSON.parse(window.localStorage.getItem(BRANDING_CACHE_KEY) || "{}")).toMatchObject({
      snapshot: { revision: 8, product_name: "Saved Eight" },
    });
  });

  it("ignores a late malformed response after an admin save", async () => {
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })));
    const saved = snapshot({ revision: 8, product_name: "Saved Eight", logo_url: null });
    render(
      <I18nProvider>
        <BrandingProvider><BrandingProbe apply={saved} /></BrandingProvider>
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply branding" }));
    await act(async () => {
      resolveFetch(new Response("{malformed", {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: '"branding-7"' },
      }));
    });
    await waitFor(() => expect(screen.getByTestId("branding-state")).toHaveTextContent("8:Saved Eight"));
    expect(JSON.parse(window.localStorage.getItem(BRANDING_CACHE_KEY) || "{}")).toMatchObject({
      snapshot: { revision: 8, product_name: "Saved Eight" },
    });
  });

  it("does not apply or write back stale, conflicting, removed, or malformed storage payloads", async () => {
    const cached = snapshot({ revision: 8, product_name: "Before rollback", logo_url: null });
    window.localStorage.setItem(BRANDING_CACHE_KEY, JSON.stringify({
      snapshot: cached,
      etag: '"branding-8"',
    }));
    const rolledBack = snapshot({ revision: 3, product_name: "After rollback", logo_url: null });
    let resolveRevalidation!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(rolledBack), {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: '"branding-3"' },
      }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveRevalidation = resolve;
      }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <I18nProvider>
        <BrandingProvider><BrandingProbe /></BrandingProvider>
      </I18nProvider>,
    );
    expect(await screen.findByText("3:After rollback")).toBeVisible();
    expect(JSON.parse(window.localStorage.getItem(BRANDING_CACHE_KEY) || "{}")).toMatchObject({
      snapshot: { revision: 3, product_name: "After rollback" },
      etag: '"branding-3"',
    });
    const persistedAfterRollback = window.localStorage.getItem(BRANDING_CACHE_KEY);
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    const oldRevision = JSON.stringify({
      snapshot: cached,
      etag: '"branding-8"',
    });
    const equalRevisionConflict = JSON.stringify({
      snapshot: snapshot({ revision: 3, product_name: "Conflicting Three", logo_url: null }),
      etag: '"branding-3"',
    });

    act(() => {
      for (const newValue of [oldRevision, equalRevisionConflict, "not-json"]) {
        window.dispatchEvent(new StorageEvent("storage", {
          key: BRANDING_CACHE_KEY,
          newValue,
        }));
      }
    });
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId("branding-state")).toHaveTextContent("3:After rollback");
    expect(window.localStorage.getItem(BRANDING_CACHE_KEY)).toBe(persistedAfterRollback);

    window.localStorage.removeItem(BRANDING_CACHE_KEY);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: BRANDING_CACHE_KEY,
        newValue: null,
      }));
    });
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(BRANDING_CACHE_KEY)).toBeNull();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).has("If-None-Match")).toBe(false);
    expect(setItemSpy).not.toHaveBeenCalled();
    await act(async () => {
      resolveRevalidation(new Response(JSON.stringify(rolledBack), {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: '"branding-3"' },
      }));
    });
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(BRANDING_CACHE_KEY)).toBeNull();
  });

  it("uses a storage event only to fetch and apply the latest public snapshot", async () => {
    const current = snapshot({ revision: 3, product_name: "Current Three", logo_url: null });
    window.localStorage.setItem(BRANDING_CACHE_KEY, JSON.stringify({
      snapshot: current,
      etag: '"branding-3"',
    }));
    const updated = snapshot({ revision: 4, product_name: "Server Four", logo_url: null });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(updated), {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: '"branding-4"' },
      }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <I18nProvider>
        <BrandingProvider><BrandingProbe /></BrandingProvider>
      </I18nProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: BRANDING_CACHE_KEY,
        newValue: JSON.stringify({ snapshot: updated, etag: '"branding-4"' }),
      }));
    });

    expect(await screen.findByText("4:Server Four")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).has("If-None-Match")).toBe(false);
  });

  it("clears cache and ETag on a malformed 200, so the next request is unconditional", async () => {
    const cached = snapshot({ revision: 5, product_name: "Cached Five", logo_url: null });
    window.localStorage.setItem(BRANDING_CACHE_KEY, JSON.stringify({
      snapshot: cached,
      etag: '"branding-5"',
    }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...snapshot({ revision: 9, logo_url: null }),
        primary_color: "not-a-color",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: '"branding-9"' },
      }))
      .mockRejectedValueOnce(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <I18nProvider>
        <BrandingProvider><BrandingProbe /></BrandingProvider>
      </I18nProvider>,
    );
    expect(await screen.findByText("0:Agent Platform")).toBeVisible();
    expect(window.localStorage.getItem(BRANDING_CACHE_KEY)).toBeNull();

    cleanup();
    render(
      <I18nProvider>
        <BrandingProvider><BrandingProbe /></BrandingProvider>
      </I18nProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const headers = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(headers.has("If-None-Match")).toBe(false);
    expect(screen.getByTestId("branding-state")).toHaveTextContent("0:Agent Platform");
  });

  it("reuses an exact 304 cache and preserves a validated cache on request failure", async () => {
    const cached = snapshot({ revision: 4, product_name: "Cached Four", logo_url: null });
    window.localStorage.setItem(BRANDING_CACHE_KEY, JSON.stringify({
      snapshot: cached,
      etag: '"branding-4"',
    }));
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(null, { status: 304 })
    ));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <I18nProvider>
        <BrandingProvider><BrandingProbe /></BrandingProvider>
      </I18nProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("branding-state")).toHaveTextContent("4:Cached Four");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("If-None-Match"))
      .toBe('"branding-4"');

    cleanup();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    render(
      <I18nProvider>
        <BrandingProvider><BrandingProbe /></BrandingProvider>
      </I18nProvider>,
    );
    expect(screen.getByTestId("branding-state")).toHaveTextContent("4:Cached Four");
    await waitFor(() => expect(window.localStorage.getItem(BRANDING_CACHE_KEY)).not.toBeNull());
  });

  it("never sends a missing or mismatched ETag and rejects an ungrounded 304", async () => {
    const valid = snapshot({ revision: 6, logo_url: null });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(valid), {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: '"branding-5"' },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await fetchPublicBranding(null);
    expect(first).toEqual({ snapshot: { ...valid, primary_color: "#123abc" } });
    await expect(fetchPublicBranding(first)).rejects.toThrow("Branding request failed (304)");
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).has("If-None-Match")).toBe(false);
  });
});
