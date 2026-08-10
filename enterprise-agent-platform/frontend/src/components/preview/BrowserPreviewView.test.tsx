// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { ApiError } from "../../lib/api";
import { relinquishBrowserControlFor } from "../../lib/browserControl";
import { BrowserPreviewView } from "./BrowserPreviewView";

const mocks = vi.hoisted(() => ({
  state: {
    connection: "connecting" as "connecting" | "connected" | "disconnected",
    activity: "loading" as "loading" | "live" | "idle",
    frameUrl: "",
    tabId: "",
    error: "",
    title: "",
    url: "",
    capturedAt: "",
    checkedAt: null as number | null,
  },
  refresh: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  send: vi.fn(),
}));

vi.mock("./useBrowserPreview", () => ({
  useBrowserPreview: () => ({ state: mocks.state, refresh: mocks.refresh }),
}));

vi.mock("../../data/previewActions", () => ({
  acquireBrowserControl: mocks.acquire,
  releaseBrowserControl: mocks.release,
  sendBrowserControlInput: mocks.send,
}));

function renderPreview(controlRequestId?: number) {
  return render(
    <I18nProvider>
      <BrowserPreviewView
        scope={{ scope_type: "private", scope_id: "7" }}
        controlRequestId={controlRequestId}
      />
    </I18nProvider>,
  );
}

function pointerEvent(type: string, values: Record<string, unknown>): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: Number(values.clientX || 0),
    clientY: Number(values.clientY || 0),
  });
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  return event;
}

async function preparePointerSurface(): Promise<HTMLElement> {
  const surface = await screen.findByRole("application");
  const image = screen.getByRole("img", { name: "Latest Agent browser frame" });
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: 1_000 },
    naturalHeight: { configurable: true, value: 500 },
  });
  image.getBoundingClientRect = () => ({
    bottom: 250,
    height: 250,
    left: 0,
    right: 500,
    top: 0,
    width: 500,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  surface.getBoundingClientRect = image.getBoundingClientRect;
  Object.assign(surface, {
    hasPointerCapture: vi.fn(() => true),
    releasePointerCapture: vi.fn(),
    setPointerCapture: vi.fn(),
  });
  return surface;
}

describe("BrowserPreviewView", () => {
  beforeEach(() => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    Object.assign(mocks.state, {
      connection: "connecting",
      activity: "loading",
      frameUrl: "",
      tabId: "",
      error: "",
      title: "",
      url: "",
      capturedAt: "",
      checkedAt: null,
    });
    mocks.acquire.mockResolvedValue({
      active: true,
      lease_id: "lease-1",
      tab_id: "tab-1",
      expires_in_ms: 90_000,
    });
    mocks.release.mockResolvedValue({ active: false, released: true });
    mocks.send.mockResolvedValue({ ok: true, expires_in_ms: 90_000 });
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("shows a loading state instead of claiming the browser is stopped before the first frame", () => {
    renderPreview();

    expect(screen.getByText("Loading browser view")).toBeVisible();
    expect(screen.queryByText("Browser is not running")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
  });

  it("shows the stopped state only after the preview endpoint reports idle", () => {
    mocks.state.connection = "connected";
    mocks.state.activity = "idle";
    renderPreview();

    expect(screen.getByText("Browser is not running")).toBeVisible();
    expect(screen.queryByText("Loading browser view")).not.toBeInTheDocument();
  });

  it("keeps an explicit work-record handoff loading until a tab appears", () => {
    mocks.state.connection = "connected";
    mocks.state.activity = "idle";
    renderPreview(1);

    expect(screen.getByText("Loading browser view")).toBeVisible();
    expect(screen.queryByText("Browser is not running")).not.toBeInTheDocument();
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it("expires a quick-control handoff without acquiring a browser that appears later", async () => {
    vi.useFakeTimers();
    mocks.state.connection = "connected";
    mocks.state.activity = "idle";
    const view = renderPreview(1);

    act(() => vi.advanceTimersByTime(15_000));
    expect(screen.getByText("Browser is not running")).toBeVisible();

    Object.assign(mocks.state, {
      activity: "live",
      frameUrl: "blob:late-frame",
      tabId: "tab-1",
    });
    view.rerender(
      <I18nProvider>
        <BrowserPreviewView
          scope={{ scope_type: "private", scope_id: "7" }}
          controlRequestId={1}
        />
      </I18nProvider>,
    );
    await act(async () => { await Promise.resolve(); });

    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(screen.getByText("Read only")).toBeVisible();
  });

  it("consumes each positive quick-control request once and ignores the normal rail", async () => {
    mocks.state.connection = "connected";
    mocks.state.activity = "live";
    mocks.state.frameUrl = "blob:live-frame";
    mocks.state.tabId = "tab-1";

    const normal = renderPreview();
    await Promise.resolve();
    expect(mocks.acquire).not.toHaveBeenCalled();
    normal.unmount();

    const assisted = renderPreview(1);
    await waitFor(() => expect(mocks.acquire).toHaveBeenCalledTimes(1));
    assisted.rerender(
      <I18nProvider>
        <BrowserPreviewView
          scope={{ scope_type: "private", scope_id: "7" }}
          controlRequestId={1}
        />
      </I18nProvider>,
    );
    await Promise.resolve();
    expect(mocks.acquire).toHaveBeenCalledTimes(1);
  });

  it("keeps quick control single-shot through the StrictMode effect probe", async () => {
    mocks.state.connection = "connected";
    mocks.state.activity = "live";
    mocks.state.frameUrl = "blob:live-frame";
    mocks.state.tabId = "tab-1";

    render(
      <StrictMode>
        <I18nProvider>
          <BrowserPreviewView
            scope={{ scope_type: "private", scope_id: "7" }}
            controlRequestId={1}
          />
        </I18nProvider>
      </StrictMode>,
    );

    await waitFor(() => expect(mocks.acquire).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Human assistance")).toBeVisible();
  });

  it("keeps the retry state distinct from a stopped browser after an initial error", () => {
    mocks.state.connection = "disconnected";
    mocks.state.error = "Temporary frame error";
    renderPreview();

    expect(screen.getByText("Temporary frame error")).toBeVisible();
    expect(screen.getByText("Loading browser view")).toBeVisible();
    expect(screen.queryByText("Browser is not running")).not.toBeInTheDocument();
  });

  it("keeps the last successful frame visible while a later refresh retries", () => {
    mocks.state.connection = "disconnected";
    mocks.state.activity = "live";
    mocks.state.frameUrl = "blob:last-frame";
    mocks.state.error = "Refresh failed";
    renderPreview();

    expect(screen.getByRole("img", { name: "Latest Agent browser frame" })).toHaveAttribute(
      "src",
      "blob:last-frame",
    );
    expect(screen.getByText("Refresh failed")).toBeVisible();
    expect(screen.queryByText("Browser is not running")).not.toBeInTheDocument();
  });

  it("refreshes on demand without making the live frame interactive", async () => {
    mocks.state.connection = "connected";
    mocks.state.activity = "live";
    mocks.state.frameUrl = "blob:live-frame";
    const user = userEvent.setup();
    renderPreview();

    await user.click(screen.getByRole("button", { name: "Refresh now" }));

    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("img", { name: "Latest Agent browser frame" })).toHaveAttribute("draggable", "false");
    expect(screen.getByText("Read only")).toBeVisible();
  });

  it("serializes human inputs and keeps their sequence bound to the leased tab", async () => {
    mocks.state.connection = "connected";
    mocks.state.activity = "live";
    mocks.state.frameUrl = "blob:live-frame";
    mocks.state.tabId = "tab-1";
    let resolveFirst: (value: { ok: boolean; expires_in_ms: number }) => void = () => undefined;
    mocks.send
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue({ ok: true, expires_in_ms: 90_000 });
    const user = userEvent.setup();
    renderPreview();

    await user.click(screen.getByRole("button", { name: "Take control" }));
    await screen.findByText("Human assistance");
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Forward" }));

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0][1]).toBe("tab-1");
    expect(mocks.send.mock.calls[0][3]).toBe(1);
    resolveFirst({ ok: true, expires_in_ms: 90_000 });
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
    expect(mocks.send.mock.calls[1][1]).toBe("tab-1");
    expect(mocks.send.mock.calls[1][3]).toBe(2);
  });

  it("captures a pointer trajectory and submits it as one bounded drag", async () => {
    mocks.state.connection = "connected";
    mocks.state.activity = "live";
    mocks.state.frameUrl = "blob:live-frame";
    mocks.state.tabId = "tab-1";
    const user = userEvent.setup();
    renderPreview();

    await user.click(screen.getByRole("button", { name: "Take control" }));
    const surface = await preparePointerSurface();

    fireEvent(surface, pointerEvent("pointerdown", {
      button: 0,
      clientX: 50,
      clientY: 50,
      isPrimary: true,
      pointerId: 7,
      pointerType: "mouse",
    }));
    fireEvent(surface, pointerEvent("pointermove", {
      clientX: 150,
      clientY: 50,
      isPrimary: true,
      pointerId: 7,
      pointerType: "mouse",
    }));
    fireEvent(surface, pointerEvent("pointerup", {
      button: 0,
      clientX: 250,
      clientY: 50,
      isPrimary: true,
      pointerId: 7,
      pointerType: "mouse",
    }));

    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
    const input = mocks.send.mock.calls[0][4] as {
      action: string;
      points: Array<{ x: number; y: number; at_ms: number }>;
    };
    expect(input.action).toBe("drag");
    expect(input.points.length).toBeGreaterThanOrEqual(2);
    expect(input.points[0]).toEqual({ x: 100, y: 100, at_ms: 0 });
    expect(input.points[input.points.length - 1]?.x).toBe(500);
    expect(input.points[input.points.length - 1]?.at_ms).toBeGreaterThan(0);
    expect(mocks.send).toHaveBeenCalledWith(
      { scope_type: "private", scope_id: "7" },
      "tab-1",
      "lease-1",
      1,
      input,
    );
  });

  it("clamps a captured drag to the frame when the pointer is released outside", async () => {
    mocks.state.connection = "connected";
    mocks.state.activity = "live";
    mocks.state.frameUrl = "blob:live-frame";
    mocks.state.tabId = "tab-1";
    const user = userEvent.setup();
    renderPreview();

    await user.click(screen.getByRole("button", { name: "Take control" }));
    const surface = await preparePointerSurface();

    fireEvent(surface, pointerEvent("pointerdown", {
      button: 0,
      clientX: 50,
      clientY: 50,
      isPrimary: true,
      pointerId: 9,
      pointerType: "mouse",
    }));
    fireEvent(surface, pointerEvent("pointerup", {
      button: 0,
      clientX: 750,
      clientY: 50,
      isPrimary: true,
      pointerId: 9,
      pointerType: "mouse",
    }));

    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
    const input = mocks.send.mock.calls[0][4] as {
      action: string;
      points: Array<{ x: number; y: number; at_ms: number }>;
    };
    expect(input.action).toBe("drag");
    expect(input.points).toHaveLength(2);
    expect(input.points[0]).toEqual({ x: 100, y: 100, at_ms: 0 });
    expect(input.points[1]?.x).toBe(1_000);
    expect(input.points[1]?.at_ms).toBeGreaterThan(0);
  });

  it("clears an interrupted local drag and releases control when pointer capture is lost", async () => {
    Object.assign(mocks.state, {
      connection: "connected",
      activity: "live",
      frameUrl: "blob:live-frame",
      tabId: "tab-1",
    });
    const user = userEvent.setup();
    renderPreview();

    await user.click(screen.getByRole("button", { name: "Take control" }));
    const surface = await preparePointerSurface();
    fireEvent(surface, pointerEvent("pointerdown", {
      button: 0,
      clientX: 50,
      clientY: 50,
      isPrimary: true,
      pointerId: 11,
      pointerType: "mouse",
    }));
    fireEvent(surface, pointerEvent("pointermove", {
      clientX: 150,
      clientY: 50,
      isPrimary: true,
      pointerId: 11,
      pointerType: "mouse",
    }));
    fireEvent(surface, pointerEvent("lostpointercapture", {
      isPrimary: true,
      pointerId: 11,
      pointerType: "mouse",
    }));

    await screen.findByText("Read only");
    expect(mocks.send).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.release).toHaveBeenCalledWith(
      { scope_type: "private", scope_id: "7" },
      "tab-1",
      "lease-1",
    ));
  });

  it("drops to read only and releases the original tab when polling selects another tab", async () => {
    mocks.state.connection = "connected";
    mocks.state.activity = "live";
    mocks.state.frameUrl = "blob:live-frame";
    mocks.state.tabId = "tab-1";
    const user = userEvent.setup();
    const view = renderPreview();
    await user.click(screen.getByRole("button", { name: "Take control" }));
    await screen.findByText("Human assistance");

    mocks.state.tabId = "tab-2";
    view.rerender(
      <I18nProvider>
        <BrowserPreviewView scope={{ scope_type: "private", scope_id: "7" }} />
      </I18nProvider>,
    );

    await screen.findByText("Read only");
    await waitFor(() => expect(mocks.release).toHaveBeenCalledWith(
      { scope_type: "private", scope_id: "7" },
      "tab-1",
      "lease-1",
    ));
  });

  it("releases control on window blur and page visibility loss", async () => {
    mocks.state.connection = "connected";
    mocks.state.activity = "live";
    mocks.state.frameUrl = "blob:live-frame";
    mocks.state.tabId = "tab-1";
    const user = userEvent.setup();
    const first = renderPreview();
    await user.click(screen.getByRole("button", { name: "Take control" }));
    await screen.findByText("Human assistance");

    act(() => window.dispatchEvent(new Event("blur")));
    await screen.findByText("Read only");
    await waitFor(() => expect(mocks.release).toHaveBeenCalledTimes(1));

    first.unmount();
    vi.clearAllMocks();
    mocks.acquire.mockResolvedValue({ lease_id: "lease-2", expires_in_ms: 90_000 });
    mocks.release.mockResolvedValue({ released: true });
    renderPreview();
    await user.click(screen.getByRole("button", { name: "Take control" }));
    await screen.findByText("Human assistance");
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));

    await screen.findByText("Read only");
    await waitFor(() => expect(mocks.release).toHaveBeenCalledWith(
      { scope_type: "private", scope_id: "7" },
      "tab-1",
      "lease-2",
    ));
  });

  it("returns to read only when the user submits a message for this scope", async () => {
    mocks.state.connection = "connected";
    mocks.state.activity = "live";
    mocks.state.frameUrl = "blob:live-frame";
    mocks.state.tabId = "tab-1";
    const user = userEvent.setup();
    renderPreview();
    await user.click(screen.getByRole("button", { name: "Take control" }));
    await screen.findByText("Human assistance");

    await act(() => relinquishBrowserControlFor({ scope_type: "private", scope_id: "7" }));
    await screen.findByText("Read only");
    await waitFor(() => expect(mocks.release).toHaveBeenCalledWith(
      { scope_type: "private", scope_id: "7" },
      "tab-1",
      "lease-1",
    ));
  });

  it("releases an in-flight acquire before allowing message submission to continue", async () => {
    mocks.state.connection = "connected";
    mocks.state.activity = "live";
    mocks.state.frameUrl = "blob:live-frame";
    mocks.state.tabId = "tab-1";
    let finishAcquire!: (value: { lease_id: string; expires_in_ms: number }) => void;
    mocks.acquire.mockImplementationOnce(() => new Promise((resolve) => {
      finishAcquire = resolve;
    }));
    const user = userEvent.setup();
    renderPreview();
    await user.click(screen.getByRole("button", { name: "Take control" }));
    await waitFor(() => expect(mocks.acquire).toHaveBeenCalledTimes(1));

    let handoff!: Promise<void>;
    act(() => {
      handoff = relinquishBrowserControlFor({ scope_type: "private", scope_id: "7" });
    });
    let handoffFinished = false;
    void handoff.then(() => { handoffFinished = true; });
    await Promise.resolve();
    expect(handoffFinished).toBe(false);

    await act(async () => {
      finishAcquire({ lease_id: "late-lease", expires_in_ms: 90_000 });
      await handoff;
    });
    expect(mocks.release).toHaveBeenCalledWith(
      { scope_type: "private", scope_id: "7" },
      "tab-1",
      "late-lease",
    );
    expect(screen.getByText("Read only")).toBeVisible();
    expect(screen.queryByText("Human assistance")).not.toBeInTheDocument();
  });

  it("expires the local lease and best-effort releases it", async () => {
    mocks.state.connection = "connected";
    mocks.state.activity = "live";
    mocks.state.frameUrl = "blob:live-frame";
    mocks.state.tabId = "tab-1";
    mocks.acquire.mockResolvedValue({ lease_id: "lease-short", expires_in_ms: 250 });
    const user = userEvent.setup();
    renderPreview();
    await user.click(screen.getByRole("button", { name: "Take control" }));
    expect(await screen.findByText("Human assistance")).toBeVisible();

    await screen.findByText("Read only");
    await waitFor(() => expect(mocks.release).toHaveBeenCalledWith(
      { scope_type: "private", scope_id: "7" },
      "tab-1",
      "lease-short",
    ));
  });

  it("treats a server lease conflict as read-only degradation", async () => {
    mocks.state.connection = "connected";
    mocks.state.activity = "live";
    mocks.state.frameUrl = "blob:live-frame";
    mocks.state.tabId = "tab-1";
    mocks.send.mockRejectedValueOnce(new ApiError("expired", 409));
    const user = userEvent.setup();
    renderPreview();
    await user.click(screen.getByRole("button", { name: "Take control" }));
    await user.click(screen.getByRole("button", { name: "Back" }));

    await screen.findByText("Read only");
    expect(screen.getByText("Browser control ended. Take control again to continue.")).toBeVisible();
    await waitFor(() => expect(mocks.release).toHaveBeenCalledWith(
      { scope_type: "private", scope_id: "7" },
      "tab-1",
      "lease-1",
    ));
  });
});
