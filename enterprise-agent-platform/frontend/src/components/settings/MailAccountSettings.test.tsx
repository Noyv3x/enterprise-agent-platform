// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY, translate } from "../../i18n";
import type { MailAccount } from "../../types";
import { MailAccountSettings } from "./MailAccountSettings";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../../lib/api", () => ({ api: mocks.api }));

const account: MailAccount = {
  id: 7,
  label: "Operations inbox",
  email_address: "agent@example.com",
  username: "agent@example.com",
  imap_host: "imap.example.com",
  imap_port: 993,
  imap_security: "tls",
  smtp_host: "smtp.example.com",
  smtp_port: 465,
  smtp_security: "tls",
  enabled: true,
  wake_enabled: true,
  wake_folder: "INBOX",
  poll_interval_seconds: 300,
  credential_configured: true,
  last_checked_at: 1_785_000_000,
  last_error: "",
  created_at: 1_784_000_000,
  updated_at: 1_785_000_000,
};

function renderSettings() {
  return render(
    <I18nProvider>
      <MailAccountSettings />
    </I18nProvider>,
  );
}

describe("MailAccountSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    mocks.api.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === "/api/private-agent/mail/accounts" && !options?.method) {
        return { accounts: [account], count: 1 };
      }
      if (path === "/api/private-agent/mail/accounts/7" && options?.method === "PATCH") {
        return { account: { ...account, label: "Operations inbox" } };
      }
      if (path.endsWith("/test")) {
        return { ok: true, connections: { imap: true, smtp: true }, account };
      }
      if (path.endsWith("/check")) {
        return { ok: true, baseline: false, new_messages: 0, stale: false, account };
      }
      throw new Error(`unexpected API call: ${path} ${options?.method || "GET"}`);
    });
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("never receives or refills the saved app password and omits a blank password patch", async () => {
    const user = userEvent.setup();
    renderSettings();
    expect(await screen.findByText("Operations inbox")).toBeVisible();
    expect(document.body).not.toHaveTextContent("mail-app-password-not-for-output");

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const password = await screen.findByLabelText(/App password/);
    expect(password).toHaveValue("");
    expect(screen.getByText("A password is configured; leave this blank to keep it.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith(
      "/api/private-agent/mail/accounts/7",
      expect.objectContaining({ method: "PATCH" }),
    ));
    const patchCall = mocks.api.mock.calls.find(
      ([path, options]) => path === "/api/private-agent/mail/accounts/7" && options?.method === "PATCH",
    );
    const body = JSON.parse(String(patchCall?.[1]?.body || "{}"));
    expect(body).not.toHaveProperty("password");
  });

  it("offers connection testing and an immediate mailbox check", async () => {
    const user = userEvent.setup();
    renderSettings();
    await screen.findByText("Operations inbox");

    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith(
      "/api/private-agent/mail/accounts/7/test",
      { method: "POST", body: "{}" },
    ));
    await user.click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith(
      "/api/private-agent/mail/accounts/7/check",
      { method: "POST", body: "{}" },
    ));
  });

  it("ships the mail surface in all three supported interface locales", () => {
    expect(translate("zh-CN", "mail.title")).toBe("邮件账户");
    expect(translate("en", "mail.title")).toBe("Mail accounts");
    expect(translate("zh-TW", "mail.title")).toBe("郵件帳戶");
    for (const locale of ["zh-CN", "en", "zh-TW"] as const) {
      expect(translate(locale, "mail.securityNotice")).not.toContain("mail.securityNotice");
      expect(translate(locale, "mail.check")).not.toContain("mail.check");
    }
  });
});
