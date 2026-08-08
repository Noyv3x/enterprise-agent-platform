// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY, translate } from "../../i18n";
import { ApiError } from "../../lib/api";
import type { SylverPlatformConnection } from "../../types";
import { SylverPlatformSettings } from "./SylverPlatformSettings";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return { ...actual, api: mocks.api };
});

const connection: SylverPlatformConnection = {
  base_url: "https://devops.sylver-lining.org",
  remote_user_id: 13,
  username: "alice",
  full_name: "Alice Chen",
  title: "Engineer",
  email: "alice@example.com",
  role: "member",
  credential_configured: true,
  verified_at: "2026-08-08T08:00:00Z",
  updated_at: "2026-08-08T08:00:00Z",
};

function renderSettings() {
  return render(
    <I18nProvider>
      <SylverPlatformSettings />
    </I18nProvider>,
  );
}

describe("SylverPlatformSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("connects with a one-time token and renders the verified identity", async () => {
    const user = userEvent.setup();
    mocks.api.mockImplementation(async (_path: string, options?: RequestInit) => {
      if (!options?.method) return { connection: null };
      if (options.method === "PUT") return { connection };
      throw new Error("unexpected request");
    });

    renderSettings();
    expect(await screen.findByText(/https:\/\/devops\.sylver-lining\.org/)).toBeVisible();
    await user.type(screen.getByLabelText("Personal API token"), "personal-token-for-test");
    await user.click(screen.getByRole("button", { name: "Connect and verify" }));

    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith(
      "/api/private-agent/integrations/sylver-platform",
      {
        method: "PUT",
        body: JSON.stringify({
          token: "personal-token-for-test",
        }),
      },
    ));
    expect(await screen.findByText("Alice Chen")).toBeVisible();
    expect(screen.getByText("alice@example.com")).toBeVisible();
    expect(screen.getByLabelText("Personal API token")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeVisible();
  });

  it("never rehydrates a saved token returned as an unexpected extra field", async () => {
    mocks.api.mockResolvedValue({
      connection: { ...connection, token: "server-secret-must-not-render" },
    });

    renderSettings();

    expect(await screen.findByText("Verified identity")).toBeVisible();
    expect(screen.getByText(connection.base_url)).toBeVisible();
    expect(screen.getByLabelText("Personal API token")).toHaveValue("");
    expect(document.body).not.toHaveTextContent("server-secret-must-not-render");
  });

  it("keeps the verified identity when reconnect verification fails", async () => {
    const user = userEvent.setup();
    mocks.api.mockImplementation(async (_path: string, options?: RequestInit) => {
      if (!options?.method) return { connection };
      if (options.method === "PUT") throw new Error("raw remote response must stay hidden");
      throw new Error("unexpected request");
    });

    renderSettings();
    expect(await screen.findByText("Alice Chen")).toBeVisible();
    await user.type(screen.getByLabelText("Personal API token"), "replacement-token");
    await user.click(screen.getByRole("button", { name: "Reconnect" }));

    expect(await screen.findByText(
      "Connection or identity verification failed. Check the token. Any existing connection was not changed.",
    )).toBeVisible();
    expect(screen.getByText("Alice Chen")).toBeVisible();
    expect(document.body).not.toHaveTextContent("raw remote response must stay hidden");
  });

  it("explains when the verified remote identity belongs to another local user", async () => {
    const user = userEvent.setup();
    mocks.api.mockImplementation(async (_path: string, options?: RequestInit) => {
      if (!options?.method) return { connection: null };
      if (options.method === "PUT") {
        throw new ApiError(
          "internal identity diagnostic must stay hidden",
          409,
          "sylver_platform_identity_conflict",
        );
      }
      throw new Error("unexpected request");
    });

    renderSettings();
    await user.type(
      await screen.findByLabelText("Personal API token"),
      "conflicting-token",
    );
    await user.click(screen.getByRole("button", { name: "Connect and verify" }));

    expect(await screen.findByText(
      "This remote identity is already connected to another local user. Ask that user to disconnect it, or use a platform token that belongs to you.",
    )).toBeVisible();
    expect(document.body).not.toHaveTextContent("internal identity diagnostic must stay hidden");
  });

  it("offers a bounded retry when the saved connection cannot be loaded", async () => {
    const user = userEvent.setup();
    mocks.api
      .mockRejectedValueOnce(new Error("internal network diagnostic must stay hidden"))
      .mockResolvedValueOnce({ connection });

    renderSettings();
    expect(await screen.findByText("The work-platform connection could not be loaded.")).toBeVisible();
    expect(document.body).not.toHaveTextContent("internal network diagnostic must stay hidden");
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Alice Chen")).toBeVisible();
    expect(mocks.api).toHaveBeenCalledTimes(2);
  });

  it("disconnects only after confirmation", async () => {
    const user = userEvent.setup();
    mocks.api.mockImplementation(async (_path: string, options?: RequestInit) => {
      if (!options?.method) return { connection };
      if (options.method === "DELETE") return { ok: true };
      throw new Error("unexpected request");
    });

    renderSettings();
    await screen.findByText("Alice Chen");
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    const confirmation = screen.getByText(
      "The saved token and remote identity will be removed, and the Agent will no longer be able to use the platform tools.",
    );
    expect(confirmation).toBeInTheDocument();
    const confirmButton = confirmation.closest(".ant-popconfirm")
      ?.querySelector<HTMLButtonElement>(".ant-popconfirm-buttons .ant-btn-primary");
    expect(confirmButton).toBeTruthy();
    fireEvent.click(confirmButton as HTMLButtonElement);

    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith(
      "/api/private-agent/integrations/sylver-platform",
      { method: "DELETE" },
    ));
    expect(await screen.findByRole("button", { name: "Connect and verify" })).toBeVisible();
    expect(screen.queryByText("Alice Chen")).not.toBeInTheDocument();
  });

  it("ships the connection surface in all supported interface locales", () => {
    expect(translate("zh-CN", "sylverPlatform.title")).toBe("Sylver Lining 工作平台");
    expect(translate("en", "sylverPlatform.connect")).toBe("Connect and verify");
    expect(translate("zh-TW", "sylverPlatform.disconnect")).toBe("中斷連接");
    for (const locale of ["zh-CN", "en", "zh-TW"] as const) {
      expect(translate(locale, "sylverPlatform.securityNotice"))
        .not.toContain("sylverPlatform.securityNotice");
      expect(translate(locale, "sylverPlatform.connectFailed"))
        .not.toContain("sylverPlatform.connectFailed");
      expect(translate(locale, "sylverPlatform.identityConflict"))
        .not.toContain("sylverPlatform.identityConflict");
    }
  });
});
