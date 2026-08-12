// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeContext } from "../../../context/ThemeContext";
import { I18nProvider, LOCALE_STORAGE_KEY, translate } from "../../../i18n";
import { ApiError } from "../../../lib/api";
import { createStore } from "../../../lib/store";
import { initialAppState, rootReducer } from "../../../store/reducer";
import { StoreContext } from "../../../store/StoreProvider";
import type { SylverPlatformConnection, SylverPlatformIdentityPreview, User } from "../../../types";
import { AntDesignProvider } from "../../ui/AntDesignProvider";
import { AccountManagement } from "./AccountManagement";
import { SylverPlatformAccountDrawer } from "./SylverPlatformAccountDrawer";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/api")>("../../../lib/api");
  return { ...actual, api: mocks.api };
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const localUser: User = {
  id: 7,
  username: "avery",
  display_name: "Avery Chen",
  position: "Engineer",
  permission_group: "member",
  permissions: ["private_agent"],
  active: true,
};

const currentConnection: SylverPlatformConnection = {
  base_url: "https://devops.sylver-lining.org",
  remote_user_id: 12,
  username: "old-avery",
  full_name: "Existing Remote Identity",
  title: "Developer",
  email: "old-avery@example.com",
  role: "member",
  credential_configured: true,
  verified_at: "2026-08-08T08:00:00Z",
  updated_at: "2026-08-08T08:00:00Z",
};

const preview: SylverPlatformIdentityPreview = {
  base_url: "https://devops.sylver-lining.org",
  remote_user_id: 13,
  username: "avery.remote",
  full_name: "Avery Remote",
  title: "Engineer",
  email: "avery@example.com",
  role: "member",
};

function Providers({ children }: { children: ReactNode }) {
  return (
    <I18nProvider>
      <ThemeContext.Provider value={{ theme: "light", toggleTheme: () => {} }}>
        <AntDesignProvider>{children}</AntDesignProvider>
      </ThemeContext.Provider>
    </I18nProvider>
  );
}

function renderDrawer(onClose = vi.fn()) {
  return render(
    <Providers>
      <SylverPlatformAccountDrawer user={localUser} open onClose={onClose} />
    </Providers>,
  );
}

function DrawerHarness() {
  const [open, setOpen] = useState(true);
  return (
    <Providers>
      <button type="button" onClick={() => setOpen(true)}>Open connection</button>
      {open ? (
        <SylverPlatformAccountDrawer user={localUser} open onClose={() => setOpen(false)} />
      ) : null}
    </Providers>
  );
}

function renderAccounts(users: User[]) {
  const store = createStore(rootReducer, initialAppState);
  store.dispatch({ type: "SET_USERS", payload: users });
  return render(
    <StoreContext.Provider value={store}>
      <Providers>
        <AccountManagement createOpen={false} onCloseCreate={() => {}} />
      </Providers>
    </StoreContext.Provider>,
  );
}

describe("administrator Sylver Lining account drawer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(() => false),
      })),
    });
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads only after the always-available low-frequency action is opened", async () => {
    const user = userEvent.setup();
    mocks.api.mockResolvedValue({ connection: null });
    renderAccounts([{ ...localUser, active: false, permissions: [] }]);

    expect(mocks.api).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(await screen.findByText("Manage Sylver Lining"));

    expect(await screen.findByRole("dialog", { name: "Sylver Lining for avery" })).toBeVisible();
    await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(1));
    expect(mocks.api).toHaveBeenCalledWith(
      "/api/admin/users/7/integrations/sylver-platform",
    );
    expect(await screen.findByText(/cannot currently use Personal AI/)).toBeVisible();
  });

  it("previews the candidate identity before confirming the exact account binding", async () => {
    const user = userEvent.setup();
    const saved = { ...currentConnection, ...preview, credential_configured: true };
    mocks.api.mockImplementation(async (path: string, options?: RequestInit) => {
      if (!options?.method) {
        return { connection: { ...currentConnection, token: "server-secret-must-not-render" } };
      }
      if (path.endsWith("/verify") && options.method === "POST") {
        return {
          identity: {
            ...preview,
            base_url: "https://untrusted-provider.example",
            token: "preview-secret-must-not-render",
          },
        };
      }
      if (options.method === "PUT") return { connection: saved };
      throw new Error("unexpected request");
    });

    renderDrawer();
    expect(await screen.findByText("Existing Remote Identity")).toBeVisible();
    expect(document.body).not.toHaveTextContent("server-secret-must-not-render");
    await user.type(screen.getByLabelText("Personal API token"), "candidate-token");
    await user.click(screen.getByRole("button", { name: "Verify identity" }));

    expect(await screen.findByText("Avery Remote")).toBeVisible();
    expect(screen.getAllByText("Avery Chen").length).toBeGreaterThan(0);
    expect(document.body).not.toHaveTextContent("preview-secret-must-not-render");
    expect(document.body).not.toHaveTextContent("untrusted-provider.example");
    expect(mocks.api).toHaveBeenCalledWith(
      "/api/admin/users/7/integrations/sylver-platform/verify",
      {
        method: "POST",
        body: JSON.stringify({ token: "candidate-token" }),
      },
    );

    await user.click(screen.getByRole("button", { name: "Confirm and save" }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith(
      "/api/admin/users/7/integrations/sylver-platform",
      {
        method: "PUT",
        body: JSON.stringify({
          token: "candidate-token",
          expected_remote_user_id: 13,
        }),
      },
    ));
    expect(screen.getByLabelText("Personal API token")).toHaveValue("");
    expect(screen.queryByRole("region", { name: "Remote identity to confirm" })).not.toBeInTheDocument();
    expect(screen.getByText("avery@example.com")).toBeVisible();
  });

  it("keeps the existing identity when verification fails and hides raw diagnostics", async () => {
    const user = userEvent.setup();
    mocks.api.mockImplementation(async (_path: string, options?: RequestInit) => {
      if (!options?.method) return { connection: currentConnection };
      if (options.method === "POST") throw new Error("raw remote diagnostic");
      throw new Error("unexpected request");
    });

    renderDrawer();
    expect(await screen.findByText("Existing Remote Identity")).toBeVisible();
    await user.type(screen.getByLabelText("Personal API token"), "bad-token");
    await user.click(screen.getByRole("button", { name: "Verify identity" }));

    expect(await screen.findByText(
      "The candidate token could not be verified. Any existing connection was not changed.",
    )).toBeVisible();
    expect(screen.getByText("Existing Remote Identity")).toBeVisible();
    expect(document.body).not.toHaveTextContent("raw remote diagnostic");
  });

  it("keeps the drawer open while a candidate mutation is in flight", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    let releaseVerify!: (value: { identity: SylverPlatformIdentityPreview }) => void;
    mocks.api.mockImplementation(async (_path: string, options?: RequestInit) => {
      if (!options?.method) return { connection: null };
      if (options.method === "POST") {
        return await new Promise((resolve) => { releaseVerify = resolve; });
      }
      throw new Error("unexpected request");
    });

    renderDrawer(onClose);
    await screen.findByText("Sylver Lining is not connected.");
    expect(screen.getByText("https://devops.sylver-lining.org")).toBeVisible();
    await user.type(screen.getByLabelText("Personal API token"), "candidate-token");
    await user.click(screen.getByRole("button", { name: "Verify identity" }));

    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Sylver Lining for avery" })).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    releaseVerify({ identity: preview });
    expect(await screen.findByText("Avery Remote")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("requires a fresh preview if the identity changes during confirmation", async () => {
    const user = userEvent.setup();
    mocks.api.mockImplementation(async (path: string, options?: RequestInit) => {
      if (!options?.method) return { connection: currentConnection };
      if (path.endsWith("/verify")) return { identity: preview };
      if (options.method === "PUT") {
        throw new ApiError("raw identity detail", 409, "sylver_platform_identity_changed");
      }
      throw new Error("unexpected request");
    });

    renderDrawer();
    await screen.findByText("Existing Remote Identity");
    await user.type(screen.getByLabelText("Personal API token"), "changed-token");
    await user.click(screen.getByRole("button", { name: "Verify identity" }));
    await user.click(await screen.findByRole("button", { name: "Confirm and save" }));

    expect(await screen.findByText(
      "The token's remote identity changed before confirmation. Verify and confirm it again.",
    )).toBeVisible();
    expect(screen.queryByRole("button", { name: "Confirm and save" })).not.toBeInTheDocument();
    expect(screen.getByText("Existing Remote Identity")).toBeVisible();
    expect(document.body).not.toHaveTextContent("raw identity detail");
  });

  it("disconnects only after confirmation and leaves no token in reopened local state", async () => {
    const user = userEvent.setup();
    mocks.api.mockImplementation(async (_path: string, options?: RequestInit) => {
      if (!options?.method) return { connection: currentConnection };
      if (options.method === "DELETE") return { ok: true };
      throw new Error("unexpected request");
    });

    render(<DrawerHarness />);
    await screen.findByText("Existing Remote Identity");
    await user.type(screen.getByLabelText("Personal API token"), "never-persist-this-token");
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Open connection" }));
    expect(await screen.findByLabelText("Personal API token")).toHaveValue("");

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    const detail = screen.getByText(
      "The saved token and remote identity will be removed, and the Agent will no longer be able to use the platform tools.",
    );
    const confirmButton = detail.closest(".ant-popconfirm")
      ?.querySelector<HTMLButtonElement>(".ant-popconfirm-buttons .ant-btn-primary")
      ?? detail.closest(".eap-popconfirm")
        ?.querySelector<HTMLButtonElement>(".eap-popconfirm-buttons .eap-btn-primary");
    expect(confirmButton).toBeTruthy();
    fireEvent.click(confirmButton as HTMLButtonElement);

    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith(
      "/api/admin/users/7/integrations/sylver-platform",
      { method: "DELETE" },
    ));
    expect(await screen.findByText("Sylver Lining is not connected.")).toBeVisible();
  });

  it("ships administrator connection copy and the Personal AI name in every locale", () => {
    expect(translate("zh-CN", "admin.accounts.sylver.manage")).toBe("管理 Sylver Lining");
    expect(translate("en", "admin.accounts.sylver.confirm")).toBe("Confirm and save");
    expect(translate("zh-TW", "admin.accounts.sylver.previewTitle")).toBe("待確認遠端身分");
    expect(translate("zh-CN", "sylverPlatform.description")).toContain("个人 AI");
    expect(translate("en", "sylverPlatform.description")).toContain("Personal AI");
    expect(translate("zh-TW", "sylverPlatform.description")).toContain("個人 AI");
  });
});
