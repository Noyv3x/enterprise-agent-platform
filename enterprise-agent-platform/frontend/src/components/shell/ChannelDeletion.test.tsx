// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALE_STORAGE_KEY } from "../../i18n";
import { resetApiSession } from "../../lib/api";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
import { TestUiProviders } from "../../test/TestUiProviders";
import type { User } from "../../types";
import { AppShell } from "./AppShell";

vi.mock("../../hooks/useRealtime", () => ({ useRealtime: () => true }));
vi.mock("../../hooks/usePolling", () => ({ usePolling: () => undefined }));
vi.mock("../../hooks/useReplyNotifications", () => ({ useReplyNotifications: () => undefined }));
vi.mock("../../data/accountActions", () => ({ ensureCurrentUserTimezone: () => Promise.resolve() }));
// Exercise the real shell, menus, confirmation and data action without mounting unrelated chat/preview resources.
vi.mock("./ContentRouter", () => ({ ContentRouter: () => <main /> }));

const manager: User = {
  id: 7, username: "manager", role: "user", permission_group: "manager",
  permissions: ["read_workspace", "private_agent", "manage_channels"],
};
function renderShell(user: User = manager) {
  const store = createStore(rootReducer, {
    ...initialAppState, user, activeView: "channel", activeChannelId: 3,
    channels: [{ id: 3, name: "roadmap" }, { id: 4, name: "support" }],
    personalAiGuideShownThisSession: true,
  });
  render(<StoreContext.Provider value={store}><TestUiProviders><AppShell /></TestUiProviders></StoreContext.Provider>);
  return store;
}
function response(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
async function openDeletion(user: UserEvent) {
  await user.click(screen.getByRole("button", { name: "Open menu" }));
  const navigation = await screen.findByRole("dialog", { name: "Main navigation" });
  await user.click(within(navigation).getByRole("button", { name: "Manage channel “roadmap”" }));
  await user.click(await screen.findByRole("menuitem", { name: "Delete channel" }));
  return screen.findByRole("dialog", { name: "Delete channel “roadmap”?" });
}

beforeEach(() => { window.localStorage.setItem(LOCALE_STORAGE_KEY, "en"); });
afterEach(() => { cleanup(); resetApiSession(); vi.unstubAllGlobals(); window.localStorage.clear(); });

describe("channel deletion in the application shell", () => {
  it("hides destructive channel controls from members without manage_channels", async () => {
    renderShell({ ...manager, permission_group: "member", permissions: ["read_workspace"] });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    const navigation = await screen.findByRole("dialog", { name: "Main navigation" });
    expect(within(navigation).queryByRole("button", { name: /Manage channel/ })).not.toBeInTheDocument();
  });

  it("retains the exact retry target after archival, navigation and mobile drawer unmount, without duplicate submissions", async () => {
    let finishDelete!: (value: Response) => void;
    const mutations: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : String(input), window.location.origin).pathname;
      if (init?.method === "DELETE") {
        mutations.push(path);
        if (mutations.length === 1) return new Promise<Response>(resolve => { finishDelete = resolve; });
        return response(200, { deleted: true, channel_id: 3 });
      }
      if (path === "/api/channels") return response(200, { channels: [{ id: 4, name: "support" }] });
      if (path === "/api/private-agent/messages") return response(200, { messages: [], agent_status: null, has_more: false, next_before_id: null });
      if (path === "/api/private-agent/telegram") return response(200, { gateway: { enabled: false }, link: null, pending: null });
      throw new Error(`Unexpected request: ${path}`);
    }));
    const store = renderShell();
    const user = userEvent.setup();
    const dialog = await openDeletion(user);
    expect(dialog).toHaveTextContent("Messages, files, sessions, and audit records are retained");
    expect(dialog).toHaveTextContent("name remains reserved");
    const confirm = within(dialog).getByRole("button", { name: "Delete channel" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(mutations).toEqual(["/api/channels/3"]));
    await act(async () => { finishDelete(response(503, { error: "Runtime cleanup failed" })); });
    await waitFor(() => expect(store.getState().activeView).toBe("private"));
    expect(store.getState().channels.map(channel => channel.id)).toEqual([4]);
    expect(store.getState().sidebarOpen).toBe(false);
    const failedDialog = await screen.findByRole("dialog", { name: "Delete channel “roadmap”?" });
    expect(within(failedDialog).getByRole("button", { name: "Retry deletion" })).toBeEnabled();
    await user.click(within(failedDialog).getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    const navigation = await screen.findByRole("dialog", { name: "Main navigation" });
    await user.click(within(navigation).getByRole("button", { name: "Manage channel “support”" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete channel" }));
    const otherDialog = await screen.findByRole("dialog", { name: "Delete channel “support”?" });
    await user.click(within(otherDialog).getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    const retryNavigation = await screen.findByRole("dialog", { name: "Main navigation" });
    await user.click(within(retryNavigation).getByRole("button", { name: "Retry deleting “roadmap”" }));
    const retryDialog = await screen.findByRole("dialog", { name: "Delete channel “roadmap”?" });
    expect(store.getState().sidebarOpen).toBe(false);
    await user.click(within(retryDialog).getByRole("button", { name: "Retry deletion" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete channel “roadmap”?" })).not.toBeInTheDocument());
    expect(mutations).toEqual(["/api/channels/3", "/api/channels/3"]);
    expect(store.getState().channels.map(channel => channel.id)).toEqual([4]);
  });

  it("does not submit a confirmation captured in an earlier account generation", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderShell();
    const dialog = await openDeletion(userEvent.setup());
    resetApiSession();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete channel" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("discards an outgoing account's failed result rather than resurrecting its retry confirmation", async () => {
    let finishDelete!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finishDelete = resolve; })));
    const store = renderShell();
    const dialog = await openDeletion(userEvent.setup());
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete channel" }));
    act(() => { resetApiSession(); store.dispatch({ type: "SET_USER", payload: { ...manager, id: 8 } }); });
    await act(async () => { finishDelete(response(503, { error: "Outgoing cleanup failure" })); });
    expect(screen.queryByRole("dialog", { name: "Delete channel “roadmap”?" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retry deleting/ })).not.toBeInTheDocument();
    expect(store.getState().channels.map(channel => channel.id)).toEqual([3, 4]);
  });
});
