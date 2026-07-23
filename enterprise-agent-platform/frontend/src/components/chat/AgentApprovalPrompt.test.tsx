// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { StoreProvider } from "../../store/StoreProvider";
import { AgentApprovalPrompt } from "./AgentApprovalPrompt";

const respondAgentApproval = vi.hoisted(() => vi.fn());

vi.mock("../../data/chatActions", () => ({ respondAgentApproval }));

describe("AgentApprovalPrompt", () => {
  beforeEach(() => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    respondAgentApproval.mockReset();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("renders only allowed choices and locks every action while submitting", async () => {
    let resolveRequest: ((value: boolean) => void) | undefined;
    respondAgentApproval.mockImplementation(() => new Promise<boolean>((resolve) => {
      resolveRequest = resolve;
    }));
    const user = userEvent.setup();

    render(
      <I18nProvider>
        <StoreProvider>
          <AgentApprovalPrompt
            mode="private"
            scopeId="7"
            approval={{
              approval_id: "approval-1",
              description: "Run the requested command",
              command: "git status --short",
              choices: ["once", "deny"],
            }}
          />
        </StoreProvider>
      </I18nProvider>,
    );

    expect(screen.getByText("git status --short")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Allow for this session" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Always allow" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Allow once" }));

    expect(respondAgentApproval).toHaveBeenCalledWith(expect.anything(), "private", "7", "once");
    expect(screen.getByRole("button", { name: /Submitting/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();

    resolveRequest?.(true);
    await waitFor(() => expect(screen.getByRole("button", { name: "Allow once" })).toBeEnabled());
  });
});
