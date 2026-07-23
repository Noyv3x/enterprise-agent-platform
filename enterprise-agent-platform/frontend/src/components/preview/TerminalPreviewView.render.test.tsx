// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { ConfigProvider } from "antd";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { TerminalPreviewView } from "./TerminalPreviewView";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  state: {
    connection: "connected" as const,
    loading: false,
    error: "",
    capturedAt: "",
    checkedAt: null,
    revision: 2,
    processes: [
      {
        id: "terminal-build",
        title: "Build",
        command: "npm run build",
        cwd: "/workspace",
        output: "building\ndone",
        running: true,
      },
      {
        id: "terminal-tests",
        title: "Tests",
        output: "250 tests passed",
        running: true,
        truncated: true,
      },
    ],
  },
}));

vi.mock("./useTerminalPreviews", () => ({
  useTerminalPreviews: () => ({ state: mocks.state, refresh: mocks.refresh }),
}));

describe("TerminalPreviewView rendering", () => {
  beforeEach(() => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    mocks.refresh.mockReset();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("switches running terminals with Ant tabs and keeps the preview read-only", async () => {
    const user = userEvent.setup();
    render(
      <ConfigProvider prefixCls="eap" theme={{ token: { motion: false } }}>
        <I18nProvider>
          <TerminalPreviewView scope={{ scope_type: "private", scope_id: "7" }} />
        </I18nProvider>
      </ConfigProvider>,
    );

    expect(screen.getByRole("tab", { name: "Build" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Read-only terminal output")).toHaveTextContent("building");
    expect(screen.getByText("Read only")).toBeVisible();

    await user.click(screen.getByRole("tab", { name: "Tests" }));

    expect(screen.getByRole("tab", { name: "Tests" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Read-only terminal output")).toHaveTextContent("250 tests passed");
    expect(screen.getByText("Showing latest output only")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Refresh now" }));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
});
