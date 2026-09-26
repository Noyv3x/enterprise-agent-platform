// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { ConfigProvider } from "antd";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
import type { ActivityStep, AgentStatus } from "../../types";
import { AgentWorkCard } from "./AgentWorkCard";

function activityStep(value: ActivityStep): ActivityStep {
  return value;
}

function renderCard(work: AgentStatus, active: boolean) {
  const store = createStore(rootReducer, initialAppState);
  const tree = (nextWork: AgentStatus, nextActive: boolean) => (
    <ConfigProvider prefixCls="eap" theme={{ token: { motion: false } }}>
      <StoreContext.Provider value={store}>
        <I18nProvider>
          <AgentWorkCard work={nextWork} active={nextActive} />
        </I18nProvider>
      </StoreContext.Provider>
    </ConfigProvider>
  );
  const view = render(tree(work, active));
  return { store, rerender: (nextWork: AgentStatus, nextActive: boolean) => view.rerender(tree(nextWork, nextActive)) };
}

function workCard(): HTMLElement {
  return screen.getByRole("region", { name: "AI work" });
}

/** The run-level disclosure is the first control in the record. */
function traceToggle(): HTMLElement {
  return within(workCard()).getAllByRole("button")[0]!;
}

function rowFor(title: string): HTMLElement {
  const row = within(workCard()).getAllByRole("listitem").find((item) => within(item).queryAllByText(title).length > 0);
  if (!row) throw new Error(`Expected a ${title} row`);
  return row;
}

describe("AgentWorkCard", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(cleanup);

  it("keeps live work open, lets finished rows show evidence, and folds to the current task", async () => {
    const command = [
      `npm test -- --runInBand ${"frontend/src/components/chat/AgentWorkCard.test.tsx ".repeat(3)}`,
      "ACTIVE_FULL_COMMAND_DETAIL",
    ].join("\n");
    renderCard({
      run_id: "run-1",
      state: "replying",
      replying_to: { username: "Administrator" },
      activity: [
        { source: "platform", stage: "replying" },
        { source: "agent", stage: "tool", tool: "tool", detail: "tool" },
        { source: "agent", stage: "tool", tool: "terminal", tool_call_id: "terminal-1", tool_status: "completed", detail: command },
        { source: "agent", stage: "tool", tool: "search_files", tool_call_id: "search-1", tool_status: "running", detail: "config · ./src" },
        { source: "agent", stage: "tool", tool: "session_search", tool_call_id: "session-search-1", tool_status: "completed", detail: "release notes" },
      ],
    }, true);

    expect(traceToggle()).toHaveAttribute("aria-expanded", "true");
    expect(within(workCard()).getAllByRole("listitem")).toHaveLength(3);
    expect(within(rowFor("File search")).queryByRole("button")).toBeNull();
    expect(traceToggle()).toHaveAccessibleDescription("Agent is replying to Administrator");
    expect(workCard()).not.toHaveTextContent("ACTIVE_FULL_COMMAND_DETAIL");

    const commandToggle = within(rowFor("Command")).getByRole("button");
    fireEvent.click(commandToggle);
    expect(commandToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Terminal command").textContent).toBe(command);

    fireEvent.click(traceToggle());
    expect(traceToggle()).toHaveAttribute("aria-expanded", "false");
    expect(traceToggle()).toHaveTextContent("File search");
    expect(traceToggle()).toHaveTextContent("config · ./src");
    expect(traceToggle()).toHaveTextContent("3 steps");
    await waitFor(() => expect(within(workCard()).queryByRole("list")).toBeNull());
  });

  it("keeps a live fold across updates and opens the next run by default", () => {
    const first: AgentStatus = {
      run_id: "run-fold",
      state: "replying",
      activity: [{ stage: "tool", tool: "read_file", tool_call_id: "read-1", tool_status: "running", parameters: { path: "src/a.ts" } }],
    };
    const { rerender } = renderCard(first, true);
    fireEvent.click(traceToggle());
    expect(traceToggle()).toHaveAttribute("aria-expanded", "false");

    rerender({
      ...first,
      activity: [
        { ...first.activity![0]!, tool_status: "completed" },
        { stage: "tool", tool: "terminal", tool_call_id: "terminal-2", tool_status: "running", parameters: { command: "npm run build" } },
      ],
    }, true);
    expect(traceToggle()).toHaveAttribute("aria-expanded", "false");
    expect(traceToggle()).toHaveTextContent("Command");
    expect(traceToggle()).toHaveTextContent("npm run build");

    rerender({ ...first, run_id: "run-next" }, true);
    expect(traceToggle()).toHaveAttribute("aria-expanded", "true");
  });

  it("collapses once when the run settles and returns focus from the closed trace to its header", async () => {
    const live: AgentStatus = {
      run_id: "run-settle",
      state: "replying",
      activity: [
        { stage: "tool.completed", tool: "terminal", tool_call_id: "terminal-s", tool_status: "completed", parameters: { command: "printf ok" }, result: "ok" },
        { stage: "tool", tool: "search_files", tool_call_id: "search-s", tool_status: "running", parameters: { query: "todo" } },
      ],
    };
    const { store, rerender } = renderCard(live, true);
    const commandToggle = within(rowFor("Command")).getByRole("button");
    act(() => commandToggle.focus());
    expect(commandToggle).toHaveFocus();

    const settled: AgentStatus = {
      ...live,
      state: "complete",
      activity: [live.activity![0]!, { ...live.activity![1]!, stage: "tool.completed", tool_status: "completed" }],
    };
    rerender(settled, false);
    expect(traceToggle()).toHaveAttribute("aria-expanded", "false");
    expect(traceToggle()).toHaveFocus();
    await waitFor(() => expect(within(workCard()).queryByRole("list")).toBeNull());

    rerender({ ...settled, updated_at: 2 }, false);
    expect(traceToggle()).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(traceToggle());
    expect(store.getState().expandedAgentRuns["run-settle"]).toBe(true);
    rerender({ ...settled, updated_at: 3 }, false);
    expect(traceToggle()).toHaveAttribute("aria-expanded", "true");
  });

  it.each([
    { name: "hands focus to the same run's next header in the same log", target: "same log", navigate: false, focused: "header" },
    { name: "never hands focus to the same run in a different log, falling back to its own log", target: "other log", navigate: false, focused: "own log" },
    { name: "does not move focus when the conversation itself changes", target: "same log", navigate: true, focused: "nothing" },
  ])("$name", async ({ target, navigate, focused }) => {
    const store = createStore(rootReducer, initialAppState);
    const live: AgentStatus = {
      run_id: "run-shared",
      state: "replying",
      activity: [{ stage: "tool.completed", tool: "terminal", tool_call_id: "terminal-shared", tool_status: "completed", parameters: { command: "ls" }, result: "README.md" }],
    };
    const settled: AgentStatus = { ...live, state: "complete" };
    const tree = (settledNow: boolean) => {
      const persisted = settledNow ? <AgentWorkCard key="persisted" work={settled} active={false} /> : null;
      return (
        <ConfigProvider prefixCls="eap" theme={{ token: { motion: false } }}>
          <StoreContext.Provider value={store}>
            <I18nProvider>
              <div role="log" aria-label="First conversation" tabIndex={0}>
                {!settledNow && <AgentWorkCard key="live" work={live} active />}
                {target === "same log" && persisted}
              </div>
              <div role="log" aria-label="Second conversation" tabIndex={0}>{target === "other log" && persisted}</div>
            </I18nProvider>
          </StoreContext.Provider>
        </ConfigProvider>
      );
    };
    const view = render(tree(false));
    act(() => within(rowFor("Command")).getByRole("button").focus());

    act(() => {
      if (navigate) store.dispatch({ type: "SET_ACTIVE_CHANNEL_ID", payload: 2 });
      view.rerender(tree(true));
    });
    await act(() => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));

    const expected = {
      header: traceToggle(),
      "own log": screen.getByRole("log", { name: "First conversation" }),
      nothing: document.body,
    }[focused]!;
    expect(document.activeElement).toBe(expected);
  });

  it("operates the record and its rows from the keyboard", async () => {
    const user = userEvent.setup();
    renderCard({
      run_id: "run-keyboard",
      state: "complete",
      activity: [{ stage: "tool.completed", tool: "terminal", tool_call_id: "terminal-k", tool_status: "completed", parameters: { command: "ls" }, result: "README.md" }],
    }, false);

    await user.tab();
    expect(traceToggle()).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(traceToggle()).toHaveAttribute("aria-expanded", "true");

    await user.tab();
    const commandToggle = within(rowFor("Command")).getByRole("button");
    expect(commandToggle).toHaveFocus();
    await user.keyboard(" ");
    expect(commandToggle).toHaveAttribute("aria-expanded", "true");
    expect(within(rowFor("Command")).getByRole("region", { name: "Terminal output" })).toHaveTextContent("README.md");

    await user.tab({ shift: true });
    await user.keyboard("{Enter}");
    expect(traceToggle()).toHaveAttribute("aria-expanded", "false");
    expect(traceToggle()).toHaveFocus();
  });

  it("keeps closing content unreachable until its transition ends, and closes at once without motion", async () => {
    const browserGetComputedStyle = window.getComputedStyle;
    let panelTransition = "0.3s, 0.3s";
    Object.defineProperty(window, "getComputedStyle", {
      configurable: true,
      value: (element: Element) => element.classList.contains("wf-trace-panel")
        ? { transitionDuration: panelTransition, transitionDelay: "0s" } as CSSStyleDeclaration
        : browserGetComputedStyle(element),
    });
    try {
      renderCard({
        run_id: "run-motion",
        state: "complete",
        activity: [{ stage: "tool.completed", tool: "terminal", tool_call_id: "terminal-m", tool_status: "completed", parameters: { command: "date" }, result: "Tue" }],
      }, false);
      fireEvent.click(traceToggle());
      const panel = document.getElementById(traceToggle().getAttribute("aria-controls")!)!;
      expect(panel).not.toHaveAttribute("inert");

      fireEvent.click(traceToggle());
      expect(panel).toHaveAttribute("inert");
      expect(within(panel).getByRole("list")).toBeInTheDocument();
      fireEvent.transitionEnd(panel);
      expect(within(panel).queryByRole("list")).toBeNull();

      panelTransition = "0s, 0s";
      fireEvent.click(traceToggle());
      expect(within(panel).getByRole("list")).toBeInTheDocument();
      fireEvent.click(traceToggle());
      await waitFor(() => expect(within(panel).queryByRole("list")).toBeNull());
    } finally {
      Object.defineProperty(window, "getComputedStyle", { configurable: true, value: browserGetComputedStyle });
    }
  });

  it("starts completed work collapsed and reveals full details one row at a time", () => {
    const command = [
      "npm test -- --runInBand frontend/src/components/chat/AgentWorkCard.test.tsx",
      "COMPLETED_COMMAND_DETAIL",
    ].join("\n");
    const searchDetail = `${"result ".repeat(20)}SEARCH_FULL_DETAIL`;
    const commentaryDetail = "I checked the focused tests.\n\nThe target behavior is ready.";
    const { store } = renderCard({
      run_id: "run-collapse",
      state: "complete",
      activity: [
        { stage: "tool.completed", tool: "terminal", tool_call_id: "terminal-1", tool_status: "completed", detail: command },
        { source: "agent", stage: "assistant.message", line: "I checked the focused tests.", detail: commentaryDetail },
        { stage: "tool.completed", tool: "search_files", tool_call_id: "search-1", tool_status: "completed", detail: searchDetail },
      ],
    }, false);
    const disclosure = traceToggle();
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(within(workCard()).queryByRole("list")).toBeNull();
    expect(disclosure).toHaveTextContent("1 terminal action · 1 search");

    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(store.getState().expandedAgentRuns["run-collapse"]).toBe(true);

    const commandRow = rowFor("Command");
    const commentaryRow = rowFor("AI update");
    const searchRow = rowFor("File search");
    expect(commandRow.compareDocumentPosition(commentaryRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(commentaryRow.compareDocumentPosition(searchRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByLabelText("Terminal command")).toBeNull();
    expect(workCard()).not.toHaveTextContent("SEARCH_FULL_DETAIL");

    const commandDisclosure = within(commandRow).getByRole("button");
    fireEvent.click(commandDisclosure);
    expect(commandDisclosure).toHaveAttribute("aria-expanded", "true");
    const commandDetail = screen.getByLabelText("Terminal command");
    expect(commandDetail.textContent).toBe(command);
    expect(commandDetail).toHaveAttribute("tabindex", "0");

    const searchDisclosure = within(searchRow).getByRole("button");
    fireEvent.click(searchDisclosure);
    expect(searchDisclosure).toHaveAttribute("aria-expanded", "true");
    expect(workCard()).toHaveTextContent("SEARCH_FULL_DETAIL");

    const commentaryDisclosure = within(commentaryRow).getByRole("button");
    fireEvent.click(commentaryDisclosure);
    expect(commentaryDisclosure).toHaveAttribute("aria-expanded", "true");
    const commentary = within(commentaryRow).getByRole("group");
    expect(commentary).toHaveTextContent("I checked the focused tests.");
    expect(commentary).toHaveTextContent("The target behavior is ready.");
  });

  it("keeps a completed tool in its original position and exposes bounded omissions", () => {
    renderCard({
      run_id: "run-bounded",
      state: "complete",
      activity: [
        { stage: "tool.started", tool: "terminal", tool_call_id: "terminal-stable", tool_status: "running", detail: "1234567890", detail_truncated_chars: 17, sequence: 1 },
        { source: "agent", stage: "assistant.message", detail: "The next phase started.", sequence: 2 },
        { stage: "tool.completed", tool: "terminal", tool_call_id: "terminal-stable", tool_status: "completed", result: "partial output", result_truncated_chars: 9, sequence: 1, updated_sequence: 3 },
        { source: "platform", stage: "work.truncated", omitted_events: 4, omitted_tool_events: 1, sequence: 4 },
      ],
    }, false);
    fireEvent.click(traceToggle());

    const commandRow = rowFor("Command");
    const commentaryRow = rowFor("AI update");
    const noticeRow = rowFor("Records truncated");
    expect(commandRow.compareDocumentPosition(commentaryRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(commentaryRow.compareDocumentPosition(noticeRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(noticeRow).toHaveTextContent("4 later work events were omitted by the safety limit");

    fireEvent.click(within(commandRow).getByRole("button"));
    expect(commandRow).toHaveTextContent("17 detail characters were omitted by the safety limit");
    expect(commandRow).toHaveTextContent("9 result characters were omitted by the safety limit");
    expect(within(commandRow).getAllByRole("note")).toHaveLength(2);
  });

  it("renders needs-review work as a visible failure instead of successful completion", () => {
    renderCard({
      run_id: "run-review",
      state: "needs_review",
      activity: [{ stage: "tool", tool: "terminal", tool_call_id: "terminal-review", tool_status: "failed" }],
    }, false);
    expect(traceToggle()).toHaveTextContent("AI work failed");
    fireEvent.click(traceToggle());
    expect(rowFor("Command")).toHaveTextContent("Failed");
  });

  it("shows file evidence first without repeating tool, status, or path facts", () => {
    renderCard({
      run_id: "run-detail",
      state: "complete",
      activity: [{
        stage: "tool.completed",
        tool: "read_file",
        tool_call_id: "read-1",
        tool_status: "completed",
        detail: "src/app.ts",
        parameters: { path: "src/app.ts", offset: 10, limit: 40, target: "sandbox" },
        result: "export function start() {\n  return 1;\n}",
        at: 1_700_000_000,
        completed_at: 1_700_000_002,
      }],
    }, false);
    fireEvent.click(traceToggle());
    const row = rowFor("Read file");
    fireEvent.click(within(row).getByRole("button"));
    const detail = within(row).getByRole("group");
    expect(within(detail).queryByText("Tool")).toBeNull();
    expect(within(detail).queryByText("Status")).toBeNull();
    expect(within(detail).queryByText("Completed")).toBeNull();
    expect(within(detail).queryByText("Path")).toBeNull();
    expect(within(detail).queryByText("Summary")).toBeNull();
    expect(within(row).getAllByText("src/app.ts")).toHaveLength(1);
    expect(within(detail).getByText("Offset")).toBeVisible();
    expect(within(detail).getByText("10")).toBeVisible();
    expect(within(detail).getByText("Time")).toBeVisible();
    expect(within(detail).queryByText("sandbox")).toBeNull();
  });

  it("does not offer an empty row disclosure for identity, status, time, and path alone", () => {
    const longPath = "packages/enterprise-agent-platform/frontend/src/components/chat/generated/deeply/nested/notes.md";
    renderCard({
      run_id: "run-path-only",
      state: "complete",
      activity: [{
        stage: "tool.completed",
        tool: "write_file",
        tool_call_id: "write-path-only",
        tool_status: "completed",
        detail: longPath,
        parameters: { path: longPath, workspace_path: longPath, target: "sandbox" },
        at: 1_700_000_000,
        completed_at: 1_700_000_002,
      }],
    }, false);
    fireEvent.click(traceToggle());
    const row = rowFor("Write file");
    expect(within(row).getAllByText(longPath)).toHaveLength(1);
    expect(within(row).getByTitle(longPath)).toBeVisible();
    expect(within(row).queryByRole("button")).toBeNull();
    expect(within(row).queryByText("Time")).toBeNull();
  });

  it("keeps action-only session identities static while preserving mixed row order", () => {
    renderCard({
      run_id: "run-action-identities",
      state: "complete",
      activity: [
        activityStep({ stage: "tool.completed", tool: "session_search", tool_call_id: "session-search-identity", tool_status: "completed", detail: "search", parameters: { action: "search" }, at: 1_700_000_000, completed_at: 1_700_000_001 }),
        activityStep({ stage: "tool.completed", tool: "terminal", tool_call_id: "terminal-evidence", tool_status: "completed", detail: "printf ready", parameters: { command: "printf ready" }, result: "ready\n[exit 0]" }),
        activityStep({ stage: "tool.completed", tool: "session", tool_call_id: "session-read-identity", tool_status: "completed", detail: "read", parameters: { action: "read" } }),
      ],
    }, false);
    fireEvent.click(traceToggle());
    const [sessionSearchRow, terminalRow, sessionRow] = within(within(workCard()).getByRole("list")).getAllByRole("listitem");
    expect(within(workCard()).getAllByRole("listitem")).toHaveLength(3);
    expect(within(sessionSearchRow!).queryByRole("button")).toBeNull();
    expect(sessionSearchRow).not.toHaveTextContent("search · search");
    expect(within(terminalRow!).queryByRole("button")).not.toBeNull();
    expect(within(sessionRow!).queryByRole("button")).toBeNull();
    expect(sessionSearchRow!.compareDocumentPosition(terminalRow!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(terminalRow!.compareDocumentPosition(sessionRow!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([
    {
      name: "terminal",
      rowTitle: "Command",
      evidence: "PASS focused suite",
      failed: false,
      step: activityStep({
        stage: "tool.completed",
        tool: "terminal",
        tool_call_id: "terminal-detail",
        tool_status: "completed",
        detail: "npm test -- --run focused.test.tsx",
        parameters: { command: "npm test -- --run focused.test.tsx", cwd: "/workspace" },
        result: "PASS focused suite",
      }),
    },
    {
      name: "process",
      rowTitle: "Process",
      evidence: "Process exited with code 0",
      failed: false,
      step: activityStep({
        stage: "tool.completed",
        tool: "process",
        tool_call_id: "process-detail",
        tool_status: "completed",
        detail: "wait",
        parameters: { action: "wait", process_id: "process-7", timeout_ms: 5_000 },
        result: "Process exited with code 0",
      }),
    },
    {
      name: "search",
      rowTitle: "File search",
      evidence: "src/components/chat/AgentWorkCard.tsx:119",
      failed: false,
      step: activityStep({
        stage: "tool.completed",
        tool: "search_files",
        tool_call_id: "search-detail",
        tool_status: "completed",
        detail: "agent_work · src",
        parameters: { query: "agent_work", path: "src", regex: true },
        result: "src/components/chat/AgentWorkCard.tsx:119",
      }),
    },
    {
      name: "browser error",
      rowTitle: "Browser",
      evidence: "Navigation timed out",
      failed: true,
      step: activityStep({
        stage: "tool.failed",
        tool: "browser",
        tool_call_id: "browser-detail",
        tool_status: "failed",
        detail: "open · https://docs.example.com",
        parameters: { action: "open", host: "https://docs.example.com" },
        result: "Navigation timed out",
      }),
    },
    {
      name: "generic tool",
      rowTitle: "Skill",
      evidence: "Loaded skill reference",
      failed: false,
      step: activityStep({
        stage: "tool.completed",
        tool: "skill",
        tool_call_id: "skill-detail",
        tool_status: "completed",
        detail: "read · docs · references/guide.md",
        parameters: { action: "read", id: "docs", file_path: "references/guide.md" },
        result: "Loaded skill reference",
      }),
    },
  ])("organizes $name details around the action object and evidence", ({ name, rowTitle, evidence, failed, step }) => {
    renderCard({ run_id: `run-family-${name}`, state: "complete", activity: [step] }, false);
    fireEvent.click(traceToggle());
    const row = rowFor(rowTitle);
    fireEvent.click(within(row).getByRole("button"));
    const detail = within(row).getByRole("group");
    expect(detail).toHaveTextContent(evidence);
    expect(within(detail).queryByText("Tool")).toBeNull();
    expect(within(detail).queryByText("Status")).toBeNull();
    expect(within(detail).queryByText("Time")).toBeNull();
    if (failed) {
      expect(within(detail).getByRole("region", { name: "Error" })).toHaveTextContent(evidence);
    }
  });

  it("says a finished run had failed steps without expanding it", () => {
    renderCard({
      run_id: "run-partial",
      state: "complete",
      activity: [
        activityStep({ stage: "tool", tool: "read_file", tool_call_id: "read-ok", tool_status: "completed", parameters: { path: "data/vendors.csv" } }),
        activityStep({ stage: "tool", tool: "web", tool_call_id: "web-failed", tool_status: "failed", result: "timeout" }),
      ],
    }, false);

    expect(traceToggle()).toHaveAttribute("aria-expanded", "false");
    expect(traceToggle()).toHaveAccessibleName(/1 failed/);
    expect(within(workCard()).getByText("1 failed")).toBeVisible();
  });

  it("adds no failure count when every step succeeded", () => {
    renderCard({
      run_id: "run-clean",
      state: "complete",
      activity: [activityStep({ stage: "tool", tool: "read_file", tool_call_id: "read-clean", tool_status: "completed", parameters: { path: "a.txt" } })],
    }, false);

    expect(traceToggle()).not.toHaveAccessibleName(/failed/);
  });
});
