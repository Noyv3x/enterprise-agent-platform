// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { ConfigProvider } from "antd";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { CompactTerminalPreview, TerminalPreviewView } from "./TerminalPreviewView";
import type { TerminalPreviewsState } from "./useTerminalPreviews";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  state: {
    connection: "connected" as const,
    loading: false,
    error: "",
    capturedAt: "",
    checkedAt: null,
    revision: "preview_render:2",
    processes: [
      {
        id: "terminal-build",
        title: "Build",
        command: "npm run build",
        cwd: "/workspace",
        output: "building\ndone",
        status: "running" as const,
        running: true,
      },
      {
        id: "terminal-tests",
        title: "Tests",
        output: "250 tests passed",
        status: "orphaned" as const,
        running: true,
        truncated: true,
      },
    ],
  } as TerminalPreviewsState,
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
    expect(screen.getByLabelText("Read-only terminal output")).toHaveTextContent("$ npm run build");
    expect(screen.getByLabelText("Read-only terminal output")).toHaveTextContent("building");
    expect(screen.getByText("Read only")).toBeVisible();

    await user.click(screen.getByRole("tab", { name: /Tests/ }));

    expect(screen.getByRole("tab", { name: /Tests/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Read-only terminal output")).toHaveTextContent("250 tests passed");
    expect(screen.getByText("Showing latest output only")).toBeVisible();
    expect(screen.getByText("Needs attention · still active")).toBeVisible();
    expect(screen.getByText(/has not confirmed that this process stopped/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Refresh now" }));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("shows a completed short command before unrelated live background terminals", () => {
    render(
      <ConfigProvider prefixCls="eap" theme={{ token: { motion: false } }}>
        <I18nProvider>
          <TerminalPreviewView
            scope={{ scope_type: "private", scope_id: "7" }}
            fallbackStep={{
              tool: "terminal",
              tool_call_id: "short-command",
              tool_status: "completed",
              parameters: { command: "printf 'ready'", cwd: "/workspace" },
              result: "ready\n[exit 0]",
              completed_at: 1784060400,
            }}
          />
        </I18nProvider>
      </ConfigProvider>,
    );

    expect(screen.getByRole("tab", { name: /Terminal 1 · \/workspace/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Read-only terminal output")).toHaveTextContent("$ printf 'ready'");
    expect(screen.getByLabelText("Read-only terminal output")).toHaveTextContent("ready");
    expect(screen.getByText("Completed · exit 0")).toBeVisible();
  });

  it("renders a real compact terminal tail for the PiP", () => {
    render(
      <ConfigProvider prefixCls="eap" theme={{ token: { motion: false } }}>
        <I18nProvider>
          <CompactTerminalPreview scope={{ scope_type: "private", scope_id: "7" }} />
        </I18nProvider>
      </ConfigProvider>,
    );

    expect(screen.getByLabelText("Read-only terminal output")).toHaveTextContent("$ npm run build");
    expect(screen.getByLabelText("Read-only terminal output")).toHaveTextContent("done");
    expect(screen.getByText("Running")).toBeVisible();
  });

  it("shows a compact skeleton before the first terminal snapshot arrives", () => {
    const previousProcesses = mocks.state.processes;
    const previousLoading = mocks.state.loading;
    mocks.state.processes = [];
    mocks.state.loading = true;
    try {
      render(
        <ConfigProvider prefixCls="eap" theme={{ token: { motion: false } }}>
          <I18nProvider>
            <CompactTerminalPreview scope={{ scope_type: "private", scope_id: "7" }} />
          </I18nProvider>
        </ConfigProvider>,
      );

      expect(screen.getByRole("status", { name: "Preparing the AI computer" }))
        .toHaveClass("terminal-preview-compact__loading");
      expect(document.querySelector(".computer-pip__skeleton")).toBeInTheDocument();
      expect(screen.queryByLabelText("Read-only terminal output")).not.toBeInTheDocument();
    } finally {
      mocks.state.processes = previousProcesses;
      mocks.state.loading = previousLoading;
    }
  });

  it("does not call a completed zero-output command pending", () => {
    render(
      <ConfigProvider prefixCls="eap" theme={{ token: { motion: false } }}>
        <I18nProvider>
          <TerminalPreviewView
            scope={{ scope_type: "private", scope_id: "7" }}
            fallbackStep={{
              tool: "terminal",
              tool_call_id: "zero-output",
              tool_status: "completed",
              parameters: { command: "true", cwd: "/workspace" },
              result: "[exit 0]",
              completed_at: 1784060400,
            }}
          />
        </I18nProvider>
      </ConfigProvider>,
    );

    expect(screen.getByLabelText("Read-only terminal output")).toHaveTextContent("$ true");
    expect(screen.getByLabelText("Read-only terminal output")).not.toHaveTextContent("Waiting for terminal output");
    expect(screen.getByText("Completed · exit 0")).toBeVisible();
  });

  it("automatically follows a newly prepended primary terminal when no tab is pinned", async () => {
    const originalProcesses = mocks.state.processes;
    mocks.state.processes = [originalProcesses[0]!];
    const renderPreview = () => (
      <ConfigProvider prefixCls="eap" theme={{ token: { motion: false } }}>
        <I18nProvider>
          <TerminalPreviewView scope={{ scope_type: "private", scope_id: "7" }} />
        </I18nProvider>
      </ConfigProvider>
    );

    try {
      const { rerender } = render(renderPreview());
      expect(screen.getByRole("tab", { name: "Build" })).toHaveAttribute("aria-selected", "true");

      mocks.state.processes = [{
        id: "terminal-foreground",
        title: "Foreground",
        command: "npm test",
        cwd: "/workspace",
        output: "test 1/20",
        status: "running",
        running: true,
      }, originalProcesses[0]!];
      rerender(renderPreview());

      await waitFor(() => {
        expect(screen.getByRole("tab", { name: "Foreground" })).toHaveAttribute("aria-selected", "true");
        expect(screen.getByLabelText("Read-only terminal output")).toHaveTextContent("$ npm test");
      });
    } finally {
      mocks.state.processes = originalProcesses;
    }
  });

  it("keeps an explicitly pinned terminal when a new primary is prepended", async () => {
    const user = userEvent.setup();
    const originalProcesses = mocks.state.processes;
    const renderPreview = () => (
      <ConfigProvider prefixCls="eap" theme={{ token: { motion: false } }}>
        <I18nProvider>
          <TerminalPreviewView scope={{ scope_type: "private", scope_id: "7" }} />
        </I18nProvider>
      </ConfigProvider>
    );

    try {
      const { rerender } = render(renderPreview());
      await user.click(screen.getByRole("tab", { name: /Tests/ }));

      mocks.state.processes = [{
        id: "terminal-foreground",
        title: "Foreground",
        command: "npm test",
        cwd: "/workspace",
        output: "test 1/20",
        status: "running",
        running: true,
      }, ...originalProcesses];
      rerender(renderPreview());

      await waitFor(() => {
        expect(screen.getByRole("tab", { name: /Tests/ })).toHaveAttribute("aria-selected", "true");
        expect(screen.getByLabelText("Read-only terminal output")).toHaveTextContent("250 tests passed");
      });
    } finally {
      mocks.state.processes = originalProcesses;
    }
  });

  it("returns to the primary terminal and resumes following when the selected process disappears", async () => {
    const user = userEvent.setup();
    const originalProcesses = mocks.state.processes;
    const renderPreview = () => (
      <ConfigProvider prefixCls="eap" theme={{ token: { motion: false } }}>
        <I18nProvider>
          <TerminalPreviewView scope={{ scope_type: "private", scope_id: "7" }} />
        </I18nProvider>
      </ConfigProvider>
    );
    const { rerender } = render(renderPreview());

    try {
      await user.click(screen.getByRole("tab", { name: /Tests/ }));
      const selectedOutput = screen.getByLabelText("Read-only terminal output");
      Object.defineProperties(selectedOutput, {
        scrollHeight: { configurable: true, value: 240 },
        clientHeight: { configurable: true, value: 80 },
      });
      selectedOutput.scrollTop = 0;
      fireEvent.scroll(selectedOutput);

      mocks.state.processes = [originalProcesses[0]!];
      rerender(renderPreview());

      await waitFor(() => {
        expect(screen.getByRole("tab", { name: "Build" })).toHaveAttribute("aria-selected", "true");
        expect(screen.getByLabelText("Read-only terminal output")).toHaveTextContent("building");
      });

      const primaryOutput = screen.getByLabelText("Read-only terminal output");
      Object.defineProperties(primaryOutput, {
        scrollHeight: { configurable: true, value: 240 },
        clientHeight: { configurable: true, value: 80 },
      });
      primaryOutput.scrollTop = 0;
      mocks.state.processes = [{
        ...originalProcesses[0]!,
        output: "building\ndone\nlatest output",
      }];
      rerender(renderPreview());
      await waitFor(() => {
        expect(screen.getByLabelText("Read-only terminal output")).toHaveTextContent("latest output");
        expect(screen.getByLabelText("Read-only terminal output").scrollTop).toBe(240);
      });

      mocks.state.processes = originalProcesses;
      rerender(renderPreview());
      await waitFor(() => {
        expect(screen.getByRole("tab", { name: "Build" })).toHaveAttribute("aria-selected", "true");
      });
    } finally {
      mocks.state.processes = originalProcesses;
    }
  });
});
