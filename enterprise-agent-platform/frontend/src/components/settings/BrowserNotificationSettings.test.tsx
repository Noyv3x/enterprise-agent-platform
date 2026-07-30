// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { browserNotificationsEnabled } from "../../lib/browserNotifications";
import { BrowserNotificationSettings } from "./BrowserNotificationSettings";

class PermissionNotification {
  static permission: NotificationPermission = "default";
  static requestPermission = vi.fn(async () => {
    PermissionNotification.permission = "granted";
    return "granted" as NotificationPermission;
  });
}

describe("BrowserNotificationSettings", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    PermissionNotification.permission = "default";
    PermissionNotification.requestPermission.mockClear();
    vi.stubGlobal("Notification", PermissionNotification);
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("requests permission only after the user enables the switch", async () => {
    render(
      <I18nProvider>
        <BrowserNotificationSettings userId={7} />
      </I18nProvider>,
    );
    expect(PermissionNotification.requestPermission).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("switch", { name: "Agent reply completed" }));

    await waitFor(() => expect(PermissionNotification.requestPermission).toHaveBeenCalledTimes(1));
    expect(browserNotificationsEnabled(7)).toBe(true);
    expect(screen.getByRole("switch", { name: "Agent reply completed" })).toBeChecked();
  });

  it("disables the switch and explains insecure contexts", () => {
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    render(
      <I18nProvider>
        <BrowserNotificationSettings userId={7} />
      </I18nProvider>,
    );

    expect(screen.getByRole("switch", { name: "Agent reply completed" })).toBeDisabled();
    expect(screen.getByText(/Use HTTPS/)).toBeVisible();
  });
});
