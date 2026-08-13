// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { ConfigProvider } from "antd";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
import type { AgentStatus } from "../../types";
import { AgentWorkCard, hasAgentBrowserStep } from "./AgentWorkCard";

describe("AgentWorkCard", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(cleanup);

  it("recognizes a substantive browser tool step without mistaking tool noise for one", () => {
    expect(hasAgentBrowserStep({
      activity: [
        { stage: "tool", tool: "tool", detail: "tool" },
        { stage: "tool.started", tool: "browser", tool_call_id: "browser-1", tool_status: "running" },
      ],
    })).toBe(true);
    expect(hasAgentBrowserStep({
      activity: [{ stage: "tool", tool: "web", tool_call_id: "web-1", tool_status: "running" }],
    })).toBe(false);
  });

  it("renders active work as compact non-interactive rows without full details", () => {
    const store = createStore(rootReducer, initialAppState);
    const command = [
      `npm test -- --runInBand ${"frontend/src/components/chat/AgentWorkCard.test.tsx ".repeat(3)}`,
      "ACTIVE_FULL_COMMAND_DETAIL",
    ].join("\n");
    const work: AgentStatus = {
      run_id: "run-1",
      state: "replying",
      replying_to: { username: "Administrator" },
      activity: [
        { source: "platform", stage: "replying" },
        { source: "agent", stage: "tool", tool: "tool", detail: "tool" },
        {
          source: "agent",
          stage: "tool",
          tool: "terminal",
          tool_call_id: "terminal-1",
          tool_status: "completed",
          detail: command,
        },
        {
          source: "agent",
          stage: "tool",
          tool: "search_files",
          tool_call_id: "search-1",
          tool_status: "running",
          detail: "config · ./src",
        },
        {
          source: "agent",
          stage: "tool",
          tool: "session_search",
          tool_call_id: "session-search-1",
          tool_status: "completed",
          detail: "release notes",
        },
      ],
    };

    render(
      <ConfigProvider prefixCls="eap" theme={{ token: { motion: false } }}>
        <StoreContext.Provider value={store}>
          <I18nProvider>
            <AgentWorkCard work={work} active={true} />
          </I18nProvider>
        </StoreContext.Provider>
      </ConfigProvider>,
    );

    const card = document.querySelector<HTMLElement>(".agent-work--active");
    expect(card).not.toBeNull();
    if (!card) throw new Error("Expected active work card");

    expect(within(card).getByText("Command")).toBeVisible();
    expect(within(card).getByText("File search")).toBeVisible();
    expect(within(card).getByText("Session search")).toBeVisible();
    expect(within(card).getAllByRole("listitem")).toHaveLength(3);
    expect(within(card).getAllByText("Completed")).toHaveLength(2);
    expect(within(card).getAllByText("Running")).toHaveLength(1);
    expect(within(card).queryByRole("button")).toBeNull();
    expect(screen.queryByLabelText("Terminal command")).toBeNull();
    expect(card).not.toHaveTextContent("ACTIVE_FULL_COMMAND_DETAIL");
    expect(card.querySelector('[data-tool="terminal"] .agent-work__preview')).toHaveTextContent(/…$/);
    expect(screen.getByText("File search · Running")).toBeVisible();
    expect(card.querySelector(".agent-work__log--live")).not.toBeNull();
    expect(card.querySelector(".agent-work__entry-list")).toBeNull();
    expect(screen.queryByText(/Using tool/i)).toBeNull();
  });

  it("starts completed work collapsed and reveals full details one row at a time", () => {
    const store = createStore(rootReducer, initialAppState);
    const command = [
      "npm test -- --runInBand frontend/src/components/chat/AgentWorkCard.test.tsx",
      "COMPLETED_COMMAND_DETAIL",
    ].join("\n");
    const searchDetail = `${"result ".repeat(20)}SEARCH_FULL_DETAIL`;
    const commentaryDetail = "I checked the focused tests.\n\nThe target behavior is ready.";
    const work: AgentStatus = {
      run_id: "run-collapse",
      state: "complete",
      activity: [
        {
          stage: "tool.completed",
          tool: "terminal",
          tool_call_id: "terminal-1",
          tool_status: "completed",
          detail: command,
        },
        {
          source: "agent",
          stage: "assistant.message",
          line: "I checked the focused tests.",
          detail: commentaryDetail,
        },
        {
          stage: "tool.completed",
          tool: "search_files",
          tool_call_id: "search-1",
          tool_status: "completed",
          detail: searchDetail,
        },
      ],
    };
    const view = render(
      <ConfigProvider prefixCls="eap" theme={{ token: { motion: false } }}>
        <StoreContext.Provider value={store}>
          <I18nProvider>
            <AgentWorkCard work={work} active={false} />
          </I18nProvider>
        </StoreContext.Provider>
      </ConfigProvider>,
    );
    const card = view.container.querySelector<HTMLElement>(".agent-work--complete");
    expect(card).not.toBeNull();
    if (!card) throw new Error("Expected completed work card");
    const disclosure = card.querySelector<HTMLElement>(".agent-work__collapse-header");
    expect(disclosure).toHaveAttribute("role", "button");
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(within(card).getByText("3 work records")).toBeVisible();
    expect(card.querySelector(".agent-work__entry-list")).toBeNull();

    fireEvent.click(disclosure!);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(store.getState().expandedAgentRuns["run-collapse"]).toBe(true);

    const commandRow = within(card).getByText("Command").closest<HTMLElement>(".agent-work__item");
    const commentaryRow = within(card).getByText("AI update").closest<HTMLElement>(".agent-work__item");
    const searchRow = within(card).getByText("File search").closest<HTMLElement>(".agent-work__item");
    expect(commandRow).not.toBeNull();
    expect(commentaryRow).not.toBeNull();
    expect(searchRow).not.toBeNull();
    if (!commandRow || !commentaryRow || !searchRow) throw new Error("Expected work rows");
    expect(
      commandRow.compareDocumentPosition(commentaryRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      commentaryRow.compareDocumentPosition(searchRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByLabelText("Terminal command")).toBeNull();
    expect(card).not.toHaveTextContent("SEARCH_FULL_DETAIL");

    const commandDisclosure = commandRow.querySelector<HTMLElement>("[role=button]");
    fireEvent.click(commandDisclosure!);
    expect(commandDisclosure).toHaveAttribute("aria-expanded", "true");
    const commandDetail = screen.getByLabelText("Terminal command");
    expect(commandDetail.textContent).toBe(command);
    expect(commandDetail).toHaveAttribute("tabindex", "0");

    const searchDisclosure = searchRow.querySelector<HTMLElement>("[role=button]");
    fireEvent.click(searchDisclosure!);
    expect(searchDisclosure).toHaveAttribute("aria-expanded", "true");
    expect(card).toHaveTextContent("SEARCH_FULL_DETAIL");

    const commentaryDisclosure = commentaryRow.querySelector<HTMLElement>("[role=button]");
    fireEvent.click(commentaryDisclosure!);
    expect(commentaryDisclosure).toHaveAttribute("aria-expanded", "true");
    const commentary = commentaryRow.querySelector(".agent-work__commentary");
    expect(commentary).toHaveTextContent("I checked the focused tests.");
    expect(commentary).toHaveTextContent("The target behavior is ready.");
  });

  it("keeps a completed tool in its original position and exposes bounded omissions", () => {
    const store = createStore(rootReducer, initialAppState);
    const work: AgentStatus = {
      run_id: "run-bounded",
      state: "complete",
      activity: [
        {
          stage: "tool.started",
          tool: "terminal",
          tool_call_id: "terminal-stable",
          tool_status: "running",
          detail: "1234567890",
          detail_truncated_chars: 17,
          sequence: 1,
        },
        {
          source: "agent",
          stage: "assistant.message",
          detail: "The next phase started.",
          sequence: 2,
        },
        {
          stage: "tool.completed",
          tool: "terminal",
          tool_call_id: "terminal-stable",
          tool_status: "completed",
          sequence: 1,
          updated_sequence: 3,
        },
        {
          source: "platform",
          stage: "work.truncated",
          omitted_events: 4,
          omitted_tool_events: 1,
          sequence: 4,
        },
      ],
    };

    const view = render(
      <ConfigProvider prefixCls="eap" theme={{ token: { motion: false } }}>
        <StoreContext.Provider value={store}>
          <I18nProvider>
            <AgentWorkCard work={work} active={false} />
          </I18nProvider>
        </StoreContext.Provider>
      </ConfigProvider>,
    );
    const card = view.container.querySelector<HTMLElement>(".agent-work--complete");
    const disclosure = card?.querySelector<HTMLElement>(".agent-work__collapse-header");
    fireEvent.click(disclosure!);

    const commandRow = within(card!).getByText("Command").closest<HTMLElement>(".agent-work__item");
    const commentaryRow = within(card!).getByText("AI update").closest<HTMLElement>(".agent-work__item");
    const noticeRow = within(card!).getByText("Records truncated").closest<HTMLElement>(".agent-work__item");
    expect(commandRow).not.toBeNull();
    expect(commentaryRow).not.toBeNull();
    expect(noticeRow).not.toBeNull();
    expect(
      commandRow!.compareDocumentPosition(commentaryRow!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      commentaryRow!.compareDocumentPosition(noticeRow!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(card).toHaveTextContent("4 later work events were omitted by the safety limit");

    fireEvent.click(commandRow!.querySelector<HTMLElement>("[role=button]")!);
    expect(card).toHaveTextContent("17 detail characters were omitted by the safety limit");
  });

  it("renders needs-review work as a warning instead of successful completion", () => {
    const store = createStore(rootReducer, initialAppState);
    const view = render(
      <ConfigProvider prefixCls="eap" theme={{ token: { motion: false } }}>
        <StoreContext.Provider value={store}>
          <I18nProvider>
            <AgentWorkCard
              active={false}
              work={{
                run_id: "run-review",
                state: "needs_review",
                activity: [{
                  stage: "tool",
                  tool: "terminal",
                  tool_call_id: "terminal-review",
                  tool_status: "failed",
                }],
              }}
            />
          </I18nProvider>
        </StoreContext.Provider>
      </ConfigProvider>,
    );
    const card = view.container.querySelector<HTMLElement>(".agent-work--complete");
    expect(card).toHaveTextContent("AI work failed");
    expect(card?.querySelector(".agent-work__done")).toHaveClass("agent-work__done--failed");
    expect(card?.querySelector(".agent-work__done--failed svg")).not.toBeNull();
  });

  it("shows tool facts, parameters, and result when a completed row is opened", () => {
    const store = createStore(rootReducer, initialAppState);
    const view = render(
      <ConfigProvider prefixCls="eap" theme={{ token: { motion: false } }}>
        <StoreContext.Provider value={store}>
          <I18nProvider>
            <AgentWorkCard
              active={false}
              work={{
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
              }}
            />
          </I18nProvider>
        </StoreContext.Provider>
      </ConfigProvider>,
    );
    const card = view.container.querySelector<HTMLElement>(".agent-work--complete");
    expect(within(card!).getByText("View AI work")).toBeVisible();
    fireEvent.click(card!.querySelector<HTMLElement>(".agent-work__collapse-header")!);
    const row = within(card!).getByText("Read file").closest<HTMLElement>(".agent-work__item");
    expect(row).not.toBeNull();
    fireEvent.click(row!.querySelector<HTMLElement>("[role=button]")!);
    expect(within(row!).getByText("Tool")).toBeVisible();
    expect(within(row!).getByText("Status")).toBeVisible();
    expect(within(row!).getAllByText("Completed").length).toBeGreaterThan(0);
    expect(within(row!).getByText("Path")).toBeVisible();
    expect(within(row!).getByText("src/app.ts")).toBeVisible();
    expect(within(row!).getByText("Offset")).toBeVisible();
    expect(within(row!).getByText("10")).toBeVisible();
    expect(within(row!).getByText("Result")).toBeVisible();
    expect(within(row!).getByText(/export function start/)).toBeVisible();
  });
});
