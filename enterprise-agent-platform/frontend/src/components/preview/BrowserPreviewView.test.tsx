// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { BrowserPreviewView } from "./BrowserPreviewView";

const mocks = vi.hoisted(() => ({
  state: {
    connection: "connecting" as "connecting" | "connected" | "disconnected",
    activity: "loading" as "loading" | "live" | "idle",
    frameUrl: "",
    error: "",
    title: "",
    url: "",
    capturedAt: "",
    checkedAt: null as number | null,
  },
  refresh: vi.fn(),
}));

vi.mock("./useBrowserPreview", () => ({
  useBrowserPreview: () => ({ state: mocks.state, refresh: mocks.refresh }),
}));

function renderPreview() {
  return render(
    <I18nProvider>
      <BrowserPreviewView scope={{ scope_type: "private", scope_id: "7" }} />
    </I18nProvider>,
  );
}

describe("BrowserPreviewView", () => {
  beforeEach(() => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    Object.assign(mocks.state, {
      connection: "connecting",
      activity: "loading",
      frameUrl: "",
      error: "",
      title: "",
      url: "",
      capturedAt: "",
      checkedAt: null,
    });
  });

  afterEach(() => {
    cleanup();
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
});
