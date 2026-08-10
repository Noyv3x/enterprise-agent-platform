// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { BrowserWorkPreview } from "./BrowserWorkPreview";

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
}));

vi.mock("./useBrowserPreview", () => ({
  useBrowserPreview: () => ({ state: mocks.state, refresh: vi.fn() }),
}));

const scope = { scope_type: "private", scope_id: "7" } as const;

describe("BrowserWorkPreview", () => {
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
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("appears immediately as a loading skeleton before the first browser frame", () => {
    render(
      <I18nProvider>
        <BrowserWorkPreview scope={scope} onTakeControl={vi.fn()} />
      </I18nProvider>,
    );

    expect(screen.getByRole("button", { name: "Open and take control of the browser" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByText("Preparing browser view").length).toBeGreaterThan(0);
    expect(screen.queryByText("Browser is not running")).not.toBeInTheDocument();
  });

  it("shows the latest frame and turns one click into one assistance request", async () => {
    mocks.state.connection = "connected";
    mocks.state.activity = "live";
    mocks.state.frameUrl = "blob:work-frame";
    const onTakeControl = vi.fn();
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <BrowserWorkPreview scope={scope} onTakeControl={onTakeControl} />
      </I18nProvider>,
    );

    expect(screen.getByRole("img", { name: "Agent browser view during this run" }))
      .toHaveAttribute("src", "blob:work-frame");
    await user.click(screen.getByRole("button", { name: "Open and take control of the browser" }));
    expect(onTakeControl).toHaveBeenCalledTimes(1);
  });
});
