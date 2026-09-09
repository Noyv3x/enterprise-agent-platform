// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../../i18n";
import { resetApiSession } from "../../../lib/api";
import { endpoints } from "../../../lib/endpoints";
import { createStore } from "../../../lib/store";
import { initialAppState, rootReducer } from "../../../store/reducer";
import { StoreContext } from "../../../store/StoreProvider";
import type { Message, User } from "../../../types";
import { PrivateAuditCard } from "./PrivateAuditCard";

interface FetchStub {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

function response(body: unknown, status = 200): FetchStub {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

const admin = { id: 7, username: "admin", role: "admin", permissions: ["admin"] } as User;
const aliceRows: Message[] = [
  { id: 101, author_type: "user", username: "Alice", content: "A_DELETED_ROW", created_at: 1 },
  { id: 102, author_type: "agent", username: "Agent", content: "A_REMAINING_ROW", created_at: 2 },
];
const conversations = [
  { user_id: 11, username: "alice", display_name: "Alice", message_count: 2 },
  { user_id: 22, username: "bob", display_name: "Bob", message_count: 1 },
];

describe("PrivateAuditCard selection under a slow earlier read", () => {
  beforeEach(() => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(() => {
    cleanup();
    resetApiSession();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("reloads the conversation the admin returns to even while its earlier slow read is still pending", async () => {
    let releaseSlowAlice!: (value: FetchStub) => void;
    let aliceReads = 0;
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return Promise.resolve(response({ deleted: 1 }));
      if (path === endpoints.privateConversations.path()) {
        return Promise.resolve(response({
          conversations: [{ ...conversations[0], message_count: 1 }, conversations[1]],
        }));
      }
      if (path === endpoints.auditPrivateMessages.path("11")) {
        aliceReads += 1;
        // Hold a pre-return snapshot after deletion; returning to Alice must
        // issue another read even while this older request is still pending.
        if (aliceReads === 2) {
          return new Promise<FetchStub>((resolve) => {
            releaseSlowAlice = resolve;
          });
        }
        return Promise.resolve(response({ messages: [aliceRows[1]], total: 1 }));
      }
      if (path === endpoints.auditPrivateMessages.path("22")) {
        return Promise.resolve(response({
          messages: [{ id: 202, author_type: "user", username: "Bob", content: "B_ONLY", created_at: 3 }],
          total: 1,
        }));
      }
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = createStore(rootReducer, {
      ...initialAppState,
      user: admin,
      messageAudit: {
        ...initialAppState.messageAudit,
        privateConversations: conversations,
        auditPrivateUserId: "11",
        privateMessages: aliceRows,
        privateTotal: 2,
      },
    });
    render(
      <I18nProvider>
        <StoreContext.Provider value={store}>
          <PrivateAuditCard confirm={async () => true} />
        </StoreContext.Provider>
      </I18nProvider>,
    );

    const deletedRow = screen.getByText("A_DELETED_ROW").closest("article");
    expect(deletedRow).not.toBeNull();
    fireEvent.click(within(deletedRow as HTMLElement).getByRole("button", { name: "Delete message" }));
    await waitFor(() => expect(screen.queryByText("A_DELETED_ROW")).not.toBeInTheDocument());
    expect(screen.getByText("A_REMAINING_ROW")).toBeVisible();

    // A1 stays pending. Mutations are disabled, but selection must stay live.
    fireEvent.click(screen.getByRole("button", { name: /Alice/ }));
    await waitFor(() => expect(aliceReads).toBe(2));
    expect(screen.getAllByRole("button", { name: "Delete message" })[0]).toBeDisabled();

    // Bob, then back to Alice while A1 is still pending.
    fireEvent.click(screen.getByRole("button", { name: /Bob/ }));
    expect(await screen.findByText("B_ONLY")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Alice/ }));
    releaseSlowAlice(response({ messages: aliceRows, total: 2 }));

    // Returning to Alice must show her current thread, not an empty list, and
    // the slow pre-delete read must not resurrect the deleted row.
    expect(await screen.findByText("A_REMAINING_ROW")).toBeVisible();
    expect(screen.queryByText("A_DELETED_ROW")).not.toBeInTheDocument();
    expect(screen.queryByText("B_ONLY")).not.toBeInTheDocument();
    expect(store.getState().messageAudit.auditPrivateUserId).toBe("11");
    expect(store.getState().messageAudit.privateTotal).toBe(1);
  });
});
