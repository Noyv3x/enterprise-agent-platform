// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { api } from "../../lib/api";
import type { PlatformUpdateStatus } from "../../types";
import { UpdateGate } from "./UpdateGate";

function status(
  state: PlatformUpdateStatus["state"],
  instanceId = "instance-a",
): PlatformUpdateStatus {
  return { state, instance_id: instanceId, retry_after_ms: 1_000 };
}

function renderGate(
  loadStatus: (signal?: AbortSignal) => Promise<PlatformUpdateStatus>,
  reload = vi.fn(),
) {
  return {
    reload,
    ...render(
      <I18nProvider>
        <UpdateGate loadStatus={loadStatus} reload={reload}>
          <div>Application content</div>
        </UpdateGate>
      </I18nProvider>,
    ),
  };
}

describe("UpdateGate", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  it("does not hold the healthy application behind a slow initial probe", () => {
    renderGate(vi.fn(() => new Promise<PlatformUpdateStatus>(() => undefined)));
    expect(screen.getByText("Application content")).toBeInTheDocument();
    expect(screen.queryByText("Checking platform status")).not.toBeInTheDocument();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("keeps the product usable while an update waits for tasks", async () => {
    renderGate(vi.fn(async () => status("waiting_for_tasks")));

    expect(await screen.findByText("Application content")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Updating ubitech agent" })).not.toBeInTheDocument();
  });

  it("rechecks an idle platform within five seconds", async () => {
    vi.useFakeTimers();
    const loadStatus = vi.fn(async () => status("idle"));
    renderGate(loadStatus);
    await act(async () => {
      await Promise.resolve();
    });
    expect(loadStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(loadStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(loadStatus).toHaveBeenCalledTimes(2);
  });

  it("blocks the product for launching, updating, and failed states", async () => {
    renderGate(vi.fn(async () => status("updating")));

    expect(
      await screen.findByRole("heading", { name: "Updating ubitech agent" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Application content")).not.toBeInTheDocument();

    cleanup();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "zh-TW");
    renderGate(vi.fn(async () => status("failed")));
    expect(await screen.findByRole("heading", { name: "更新未能安全完成" })).toBeInTheDocument();
    expect(screen.queryByText("Application content")).not.toBeInTheDocument();
  });

  it("stays on maintenance when connectivity drops after an update was observed", async () => {
    const loadStatus = vi.fn()
      .mockResolvedValueOnce(status("updating"))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValue(status("updating"));
    renderGate(loadStatus);
    expect(await screen.findByRole("heading", { name: "Updating ubitech agent" })).toBeInTheDocument();

    window.dispatchEvent(new Event("pageshow"));
    await waitFor(() => expect(loadStatus).toHaveBeenCalledTimes(2));

    expect(screen.getByRole("heading", { name: "Updating ubitech agent" })).toBeInTheDocument();
    expect(screen.queryByText("Application content")).not.toBeInTheDocument();
  });

  it("reloads once after maintenance returns to idle", async () => {
    const loadStatus = vi.fn()
      .mockResolvedValueOnce(status("updating"))
      .mockResolvedValue(status("idle", "instance-b"));
    const { reload } = renderGate(loadStatus);
    expect(await screen.findByRole("heading", { name: "Updating ubitech agent" })).toBeInTheDocument();

    window.dispatchEvent(new Event("pageshow"));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Application content")).toBeInTheDocument();

    window.dispatchEvent(new Event("pageshow"));
    await waitFor(() => expect(loadStatus).toHaveBeenCalledTimes(3));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads when a new idle backend instance is detected", async () => {
    const loadStatus = vi.fn()
      .mockResolvedValueOnce(status("idle", "instance-a"))
      .mockResolvedValue(status("idle", "instance-b"));
    const { reload } = renderGate(loadStatus);
    expect(await screen.findByText("Application content")).toBeInTheDocument();

    window.dispatchEvent(new Event("pageshow"));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it("switches immediately when a business API returns platform_updating", async () => {
    const loadStatus = vi.fn()
      .mockResolvedValueOnce(status("idle"))
      .mockResolvedValue(status("updating"));
    renderGate(loadStatus);
    expect(await screen.findByText("Application content")).toBeInTheDocument();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ code: "platform_updating", error: "platform_updating" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    )));

    await act(async () => {
      await expect(api("/api/private-agent/messages")).rejects.toMatchObject({
        status: 503,
        code: "platform_updating",
      });
    });

    expect(screen.getByRole("heading", { name: "Updating ubitech agent" })).toBeInTheDocument();
    expect(screen.queryByText("Application content")).not.toBeInTheDocument();
  });
});
