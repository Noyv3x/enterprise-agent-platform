// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "../api";
import { ThemeProvider } from "../context/ThemeContext";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../i18n";
import { refreshChats, resetChatStore } from "../views/chat/chatStore";
import { accessFor, allowed, landingRoute, parseRoute, type Route } from "./routes";
import { Sidebar } from "./Sidebar";

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../api", () => api);

const admin: User = { id: 1, username: "root", display_name: "Root", role: "admin", position: "", permission_group: "", thinking_depth: "", timezone: "UTC", active: true };
const member: User = { ...admin, id: 2, username: "mia", display_name: "Mia", role: "user" };
const chats = [
  { id: "c1", user_id: 1, title: "Budget review", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-03T00:00:00Z", deleted_at: null },
  { id: "c2", user_id: 1, title: "Release notes", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-02T00:00:00Z", deleted_at: null },
];

function serve() {
  api.request.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/chat/conversations") return { conversations: chats };
    if (init?.method === "PATCH") return { conversation: { ...chats[1], ...JSON.parse(String(init.body)), updated_at: "2026-09-04T00:00:00Z" } };
    if (init?.method === "DELETE") return {};
    throw new Error(`unexpected ${path}`);
  });
}

function renderSidebar(user: User, permissions: string[], route: Route = { view: "chat", id: null }, onClose?: () => void, collapsed = false) {
  const navigate = vi.fn();
  render(
    <I18nProvider>
      <ThemeProvider>
        <Sidebar
          user={user}
          channels={[{ id: 4, name: "Product", description: "", archived: false }, { id: 5, name: "Old", description: "", archived: true }]}
          access={accessFor(user.role, permissions)}
          route={route}
          navigate={navigate}
          onSignOut={vi.fn()}
          collapsed={collapsed}
          onCollapsedChange={vi.fn()}
          drawer={!!onClose}
          onClose={onClose}
        />
      </ThemeProvider>
    </I18nProvider>,
  );
  return navigate;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetChatStore();
  window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  serve();
});
afterEach(cleanup);

describe("Sidebar", () => {
  it("closes the mobile drawer on every navigation selection, including the active route", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const navigate = renderSidebar(admin, [], { view: "chat", id: "c1" }, onClose);
    await screen.findByRole("button", { name: "Budget review" });
    for (const [name, route] of [
      ["Budget review", "chat-c1"],
      ["Plain chat", "chat-c1"],
      ["New chat", "chat"],
      ["Product", "channel-4"],
      ["Personal AI", "private"],
      ["Channels", "channels"],
      ["Admin", "admin"],
      ["Settings", "settings"],
    ]) {
      onClose.mockClear();
      const selection = screen.getAllByRole("button", { name }).find((button) => !button.hasAttribute("aria-expanded"))!;
      await user.click(selection);
      expect(navigate).toHaveBeenLastCalledWith(route);
      expect(onClose).toHaveBeenCalledTimes(1);
    }
  });

  it("shows only the areas a member's permissions open", async () => {
    renderSidebar(member, ["private_agent"], { view: "private" });
    const nav = screen.getByRole("complementary", { name: "Workspace navigation" });
    expect(within(nav).getByRole("button", { name: "Personal AI" })).toBeVisible();
    for (const hidden of ["Plain chat", "Channels", "Admin", "New chat"]) expect(within(nav).queryByRole("button", { name: hidden })).not.toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Settings" })).toBeVisible();
    expect(api.request).not.toHaveBeenCalled();
  });

  it("names the primary areas 个人 AI, 纯聊天模式, 频道 in that order, in every locale", async () => {
    const names = {
      en: ["Personal AI", "Plain chat", "Channels", "New chat"],
      "zh-CN": ["个人 AI", "纯聊天模式", "频道", "新聊天"],
      "zh-TW": ["個人 AI", "純聊天模式", "頻道", "新聊天"],
    };
    for (const [locale, [personal, chat, channels, newChat]] of Object.entries(names)) {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
      renderSidebar(admin, []);
      const nav = screen.getByRole("complementary");
      const order = [personal, chat, channels, newChat].map((name) => within(nav).getAllByRole("button", { name })[0]);
      // New chat belongs to the open chat area: it follows the primary items instead of leading them.
      for (let index = 1; index < order.length; index++) {
        expect(order[index - 1].compareDocumentPosition(order[index]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
      expect(within(nav).getByRole("button", { name: chat })).toHaveAttribute("aria-current", "page");
      cleanup();
    }
  });

  it("shows New chat, the chat list and chat search only inside Plain chat, also on the rail and in the drawer", async () => {
    const user = userEvent.setup();
    const chatControls = ["New chat", "Search chats", "Chats", "Budget review", "Release notes"];
    const outside: Route[] = [{ view: "private" }, { view: "channels" }, { view: "channel", id: 4 }, { view: "settings" }, { view: "admin" }];
    for (const variant of ["sidebar", "rail", "drawer"] as const) {
      for (const route of outside) {
        const navigate = renderSidebar(admin, [], route, variant === "drawer" ? vi.fn() : undefined, variant === "rail");
        // The chat list still loads, so Plain chat can open the latest chat from any area.
        await act(() => refreshChats());
        const nav = screen.getByRole("complementary");
        for (const name of chatControls) expect(within(nav).queryByRole("button", { name })).not.toBeInTheDocument();
        await user.click(within(nav).getByRole("button", { name: "Plain chat" }));
        expect(navigate).toHaveBeenLastCalledWith("chat-c1");
        cleanup();
      }
      renderSidebar(admin, [], { view: "chat", id: "c1" }, variant === "drawer" ? vi.fn() : undefined, variant === "rail");
      await act(() => refreshChats());
      const nav = screen.getByRole("complementary");
      // On the rail the list is inert and the rail's own search button stands in for it.
      expect(within(nav).getAllByRole("button", { name: "Search chats" })[0]).toBeVisible();
      expect(within(nav).getByRole("button", { name: "New chat" })).toBeVisible();
      expect(within(nav).getByRole("button", { name: "Budget review" })).toHaveAttribute("aria-current", "page");
      cleanup();
    }
  });

  it("opens a blank chat from Plain chat when there is no chat yet", async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(async () => ({ conversations: [] }));
    const navigate = renderSidebar(admin, [], { view: "private" });
    await act(() => refreshChats());
    await user.click(screen.getByRole("button", { name: "Plain chat" }));
    expect(navigate).toHaveBeenLastCalledWith("chat");
  });

  it("re-reads the chat list when Plain chat opens, so titles generated meanwhile show", async () => {
    let reads = 0;
    api.request.mockImplementation(async () => ({ conversations: [{ ...chats[0], title: ++reads === 1 ? "New chat" : "Budget review" }] }));
    const props = {
      user: admin, channels: [], access: accessFor(admin.role, []), navigate: vi.fn(), onSignOut: vi.fn(),
      collapsed: false, onCollapsedChange: vi.fn(),
    };
    const tree = (route: Route) => (
      <I18nProvider><ThemeProvider><Sidebar {...props} route={route} /></ThemeProvider></I18nProvider>
    );
    const { rerender } = render(tree({ view: "private" }));
    await act(() => refreshChats());
    rerender(tree({ view: "chat", id: "c1" }));
    expect(await screen.findByRole("button", { name: "Budget review" })).toHaveAttribute("aria-current", "page");
  });

  it("lists open channels and chats for an administrator, and searches chats", async () => {
    const user = userEvent.setup();
    const navigate = renderSidebar(admin, [], { view: "chat", id: "c2" });
    expect(screen.getByRole("button", { name: "Admin" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Product" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Old" })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Release notes" })).toHaveAttribute("aria-current", "page");

    await user.click(screen.getByRole("button", { name: "Search chats" }));
    await user.type(screen.getByRole("textbox", { name: "Search chat history" }), "budg");
    expect(screen.queryByRole("button", { name: "Release notes" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Budget review" }));
    expect(navigate).toHaveBeenCalledWith("chat-c1");
  });

  it("renames a chat through its row menu", async () => {
    const user = userEvent.setup();
    renderSidebar(admin, []);
    await user.click(await screen.findByRole("button", { name: "More actions for Release notes" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const title = screen.getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "  Launch notes ");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(api.request).toHaveBeenCalledWith("/api/chat/conversations/c2", { method: "PATCH", body: JSON.stringify({ title: "Launch notes" }) });
    expect(await screen.findByRole("button", { name: "Launch notes" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("deletes the open chat after confirmation and returns to a new chat", async () => {
    const user = userEvent.setup();
    const navigate = renderSidebar(admin, [], { view: "chat", id: "c1" });
    await user.click(await screen.findByRole("button", { name: "More actions for Budget review" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(api.request).not.toHaveBeenCalledWith("/api/chat/conversations/c1", { method: "DELETE" });
    await user.click(screen.getByRole("button", { name: "Delete chat" }));
    expect(api.request).toHaveBeenCalledWith("/api/chat/conversations/c1", { method: "DELETE" });
    expect(navigate).toHaveBeenCalledWith("chat");
    expect(screen.queryByRole("button", { name: "Budget review" })).not.toBeInTheDocument();
  });

  it("moves focus to the next chat after a delete, and to New chat once the list is empty", async () => {
    const user = userEvent.setup();
    renderSidebar(admin, []);
    const remove = async (title: string) => {
      await user.click(await screen.findByRole("button", { name: `More actions for ${title}` }));
      await user.click(screen.getByRole("menuitem", { name: "Delete" }));
      await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: /^Delete/ }));
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    };
    await remove("Budget review");
    expect(screen.getByRole("button", { name: "Release notes" })).toHaveFocus();
    await remove("Release notes");
    expect(screen.getByRole("button", { name: "New chat" })).toHaveFocus();
  });
});

describe("routes", () => {
  it("treats malformed chat escapes as unknown and decodes valid IDs", () => {
    for (const hash of ["#chat-%", "#chat-%GG", "#chat-%E0%A4%A", "#chat-%FF"]) {
      expect(parseRoute(hash)).toEqual({ view: "unknown" });
    }
    expect(parseRoute("#chat-thread%2F%E4%B8%AD")).toEqual({ view: "chat", id: "thread/中" });
  });

  it("parses every hash route and gates it by permission", () => {
    expect(parseRoute("#admin/usage")).toEqual({ view: "admin" });
    expect(parseRoute("#settings/skills")).toEqual({ view: "settings" });
    expect(parseRoute("#chat-abc")).toEqual({ view: "chat", id: "abc" });
    expect(parseRoute("#chat")).toEqual({ view: "chat", id: null });
    expect(parseRoute("#channel-7")).toEqual({ view: "channel", id: 7 });
    expect(parseRoute("")).toEqual({ view: "private" });
    expect(parseRoute("#nowhere")).toEqual({ view: "unknown" });
    expect(parseRoute("#schedules")).toEqual({ view: "unknown" });
    const reader = accessFor("user", ["read_workspace"]);
    expect(allowed({ view: "channel", id: 7 }, reader)).toBe(true);
    expect(allowed({ view: "chat", id: null }, reader)).toBe(false);
    expect(allowed({ view: "admin" }, reader)).toBe(false);
    expect(allowed({ view: "settings" }, reader)).toBe(true);
  });

  it("lands on Personal AI when entering, except at a specific chat or channel, and keeps the page on reload", () => {
    const personal = accessFor("user", ["private_agent", "chat", "read_workspace"]);
    for (const hash of ["", "chat", "channels", "admin", "settings", "nowhere"]) expect(landingRoute(hash, personal, true)).toBe("private");
    for (const hash of ["private", "chat-abc", "channel-7"]) expect(landingRoute(hash, personal, true)).toBeNull();
    // A reload, back/forward or in-app navigation keeps a real page; only bare or unknown addresses move.
    expect(landingRoute("chat-abc", personal, false)).toBeNull();
    expect(landingRoute("channel-7", personal, false)).toBeNull();
    expect(landingRoute("", personal, false)).toBe("private");
    expect(landingRoute("nowhere", personal, false)).toBe("private");
    // Without Personal AI the addressed page stays, and bare or unknown addresses open the first permitted area.
    const chatter = accessFor("user", ["chat", "read_workspace"]);
    expect(landingRoute("channel-7", chatter, true)).toBeNull();
    expect(landingRoute("", chatter, true)).toBe("chat");
    expect(landingRoute("nowhere", accessFor("user", ["read_workspace"]), true)).toBe("channels");
    expect(landingRoute("", accessFor("user", []), true)).toBe("settings");
  });
});
