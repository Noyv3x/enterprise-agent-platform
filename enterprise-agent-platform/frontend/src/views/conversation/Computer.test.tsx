// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShellContext } from "../../components/ui/beautiful/controls";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { Conversation } from "../Conversation";
import type { BrowserTab, Message } from "./types";

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../api", () => api);

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  constructor(public url: string) {
    super();
    FakeEventSource.instances.push(this);
  }
  close() {}
}

let seq = 0;
function emit(event: Record<string, unknown> & { type: string }) {
  act(() => {
    FakeEventSource.instances[0].dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify({ seq: ++seq, ...event }), lastEventId: String(seq) }));
  });
}

const input = (id: string, delta: string) => emit({ type: "tool_input_delta", tool_call_id: id, delta });
const text = (value: string) => [{ type: "text", text: value }];
/** One finished tool step: input start, authoritative arguments, end. */
function step(id: string, name: string, args: Record<string, unknown>, output = "ok", isError = false) {
  emit({ type: "tool_input_start", tool_call_id: id, name });
  emit({ type: "tool_start", tool_call_id: id, name, args });
  emit({ type: "tool_end", tool_call_id: id, is_error: isError, content_preview: text(output), details: null });
}

function tool(id: string, name: string, args: Record<string, unknown>, output = "ok") {
  return { type: "tool", id, name, args, status: "done", output, started_at: "2026-10-01T05:22:01Z", ended_at: "2026-10-01T05:22:02Z" };
}

function reply(id: number, tools: Record<string, unknown>[] = []): Message {
  const work = tools.length ? { v: 1, started_at: "2026-10-01T05:22:00Z", ended_at: "2026-10-01T05:22:12Z", truncated: false, items: tools } : undefined;
  return { id, role: "assistant", content: `Reply ${id}.`, metadata: { status: "completed", ...(work ? { work } : {}) }, created_at: "2026-10-01T05:22:12Z", attachments: [] };
}

let tabs: BrowserTab[] = [];
let lease: { holder_user_id: number; expires_at: string } | null = null;

async function mount(messages: Message[] = []) {
  api.request.mockImplementation(async (path: string, options: RequestInit = {}) => {
    const method = options.method ?? "GET";
    if (path.startsWith("/api/conversations/private/messages")) return { messages, next_before_id: null, last_seq: 0, compaction: null };
    if (path === "/api/browser") return { tabs, lease };
    if (path === "/api/browser/lease" && method === "POST") return { lease: (lease = { holder_user_id: 1, expires_at: "2026-10-01T06:00:00Z" }) };
    if (path === "/api/browser/lease" && method === "DELETE") {
      lease = null;
      return { ok: true };
    }
    if (path.startsWith("/api/workspace/files")) return { files: [] };
    throw new Error(`unexpected ${method} ${path}`);
  });
  const aside = document.createElement("div");
  document.body.append(aside);
  render(
    <I18nProvider>
      <ShellContext.Provider value={{ narrow: false, openNavigation: () => undefined, asideSlot: aside }}>
        <Conversation scope="private" />
      </ShellContext.Provider>
    </I18nProvider>,
  );
  const panel = await screen.findByRole("complementary", { name: "Computer" });
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  return panel;
}

const windowOf = (panel: HTMLElement) => within(panel).getByRole("region", { name: "Computer screen" });

describe("Computer panel", () => {
  beforeEach(() => {
    seq = 0;
    tabs = [];
    lease = null;
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("is one window with no view switcher, the live browser when there is no step", async () => {
    tabs = [{ tabId: "t1", url: "https://example.com/", title: "Example" }];
    const panel = await mount();
    expect(within(panel).getAllByRole("region", { name: "Computer screen" })).toHaveLength(1);
    expect(within(panel).queryByRole("tablist")).not.toBeInTheDocument();
    expect(within(panel).queryByRole("tab")).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /follow/i })).not.toBeInTheDocument();
    expect(await within(windowOf(panel)).findByRole("img", { name: "Browser screen: Example" })).toBeVisible();
    expect(within(windowOf(panel)).getByText("https://example.com/")).toBeVisible();
    expect(within(panel).getByText("Idle")).toBeVisible();
    // Fewer than two steps: nothing to play back.
    expect(within(panel).getByRole("slider", { name: "Step" })).toHaveAttribute("aria-disabled", "true");
    expect(within(panel).getByRole("button", { name: "Previous step" })).toBeDisabled();
  });

  it("follows the AI across kinds: a streaming write, live bash output replaced at tool_end, then the live browser", async () => {
    tabs = [{ tabId: "t1", url: "https://example.com/", title: "Example" }];
    const panel = await mount();
    await within(windowOf(panel)).findByRole("img", { name: "Browser screen: Example" });

    emit({ type: "tool_input_start", tool_call_id: "w1", name: "write" });
    input("w1", '{"path":"src/app.ts","content":"const a = 1;\\nconst b');
    let win = windowOf(panel);
    expect(within(win).queryByRole("img", { name: /Browser screen/ })).not.toBeInTheDocument();
    expect(within(win).getByText("app.ts")).toBeVisible();
    expect(within(win).getByText("src/app.ts")).toBeVisible();
    expect(within(win).getByText("const a = 1;")).toBeVisible();
    expect(within(win).getByText("const b")).toBeVisible();
    expect(within(panel).getByText("Write app.ts")).toBeVisible();
    expect(within(panel).getByText("Working")).toBeVisible();
    expect(within(panel).getByText("Live")).toBeVisible();

    input("w1", ' = 2;\\nconst c = 3;"}');
    expect(within(win).getByText("const b = 2;")).toBeVisible();
    emit({ type: "tool_start", tool_call_id: "w1", name: "write", args: { path: "src/app.ts", content: "final 1\nfinal 2" } });
    expect(within(win).getByText("final 2")).toBeVisible();
    emit({ type: "tool_end", tool_call_id: "w1", is_error: false, content_preview: text("ok"), details: null });
    // Between steps the live run is thinking.
    expect(within(panel).getByText("Thinking")).toBeVisible();

    // A new step takes the window as soon as it begins.
    emit({ type: "tool_input_start", tool_call_id: "b1", name: "bash" });
    const log = within(windowOf(panel)).getByRole("log", { name: "Terminal output" });
    expect(within(windowOf(panel)).getByText("Terminal")).toBeVisible();
    emit({ type: "tool_start", tool_call_id: "b1", name: "bash", args: { command: "npm test" } });
    expect(log).toHaveTextContent("$ npm test");
    expect(within(panel).getByText("Run npm test")).toBeVisible();
    emit({ type: "tool_output", tool_call_id: "b1", delta: "compiling\n" });
    emit({ type: "tool_output", tool_call_id: "b1", delta: "3 passed\n" });
    expect(log).toHaveTextContent(/compiling\s*3 passed/);
    expect(log).toHaveAttribute("aria-live", "off");
    emit({ type: "tool_end", tool_call_id: "b1", is_error: true, content_preview: text("FINAL: 1 failed"), details: null });
    expect(log).toHaveTextContent("FINAL: 1 failed");
    expect(log).not.toHaveTextContent("compiling");
    expect(within(log).getByRole("img", { name: "Failed" })).toBeInTheDocument();
    expect(within(panel).getByRole("status")).toHaveTextContent("Command failed");

    step("br1", "browser", { action: "navigate", url: "https://example.com/" });
    win = windowOf(panel);
    expect(within(win).getByRole("img", { name: "Browser screen: Example" })).toBeVisible();
    expect(within(panel).getByText("Browse example.com")).toBeVisible();
    expect(within(panel).getByText("3 / 3")).toBeVisible();
  });

  it("reviews an earlier step that new steps and a new run never move, then returns to live", async () => {
    const user = userEvent.setup();
    const panel = await mount();
    step("b1", "bash", { command: "ls" }, "a.md");
    step("w1", "write", { path: "notes.md", content: "hello notes" });
    emit({ type: "tool_start", tool_call_id: "b2", name: "bash", args: { command: "sleep 9" } });

    await user.click(within(panel).getByRole("button", { name: "Previous step" }));
    const slider = within(panel).getByRole("slider", { name: "Step" });
    expect(slider).toHaveAttribute("aria-valuetext", "Step 2 of 3: Write notes.md");
    expect(within(windowOf(panel)).getByText("hello notes")).toBeVisible();
    expect(within(panel).getByText("2 / 3")).toBeVisible();
    expect(within(panel).queryByText("Live")).not.toBeInTheDocument();

    // New steps only update the count.
    step("b3", "bash", { command: "date" });
    expect(within(windowOf(panel)).getByText("hello notes")).toBeVisible();
    expect(within(panel).getByText("2 / 4")).toBeVisible();

    // The run ends and the next one starts: the reviewed step stays, resolved by the reply it became.
    emit({ type: "run_end", message: reply(5, [tool("b1", "bash", { command: "ls" }), tool("w1", "write", { path: "notes.md", content: "hello notes" })]) });
    emit({ type: "tool_start", tool_call_id: "x1", name: "bash", args: { command: "uptime" } });
    expect(within(windowOf(panel)).getByText("hello notes")).toBeVisible();

    // Keyboard review within the reviewed run.
    slider.focus();
    await user.keyboard("{Home}");
    expect(within(windowOf(panel)).getByRole("log", { name: "Terminal output" })).toHaveTextContent("$ ls");
    await user.keyboard("{End}");
    expect(within(panel).getByRole("slider", { name: "Step" })).toHaveAttribute("aria-valuetext", "Step 4 of 4: Run date");

    await user.click(within(panel).getByRole("button", { name: "Back to live" }));
    expect(within(windowOf(panel)).getByRole("log", { name: "Terminal output" })).toHaveTextContent("$ uptime");
    expect(within(panel).getByText("Live")).toBeVisible();
    expect(within(panel).getByText("1 / 1")).toBeVisible();
  });

  it("opens an older reply's step from the conversation with View in computer", async () => {
    const user = userEvent.setup();
    const older = reply(2, [tool("t1", "bash", { command: "make" }, "built")]);
    const latest = reply(4, [tool("s1", "web_search", { query: "pi agent" }, "Pi agent docs https://pi.dev/docs.\nMore")]);
    const panel = await mount([older, latest]);
    expect(within(windowOf(panel)).getByText("pi agent")).toBeVisible();
    const link = within(windowOf(panel)).getByRole("link", { name: "https://pi.dev/docs" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));

    const [olderReply] = screen.getAllByRole("article", { name: "Agent reply" });
    await user.click(within(olderReply).getByRole("button", { name: "View in computer" }));
    expect(within(windowOf(panel)).getByRole("log", { name: "Terminal output" })).toHaveTextContent(/\$ make\s*built/);
    expect(within(panel).getByText("Run make")).toBeVisible();
    expect(within(panel).getByText("1 / 1")).toBeVisible();

    await user.click(within(panel).getByRole("button", { name: "Back to latest step" }));
    expect(within(windowOf(panel)).getByRole("link", { name: "https://pi.dev/docs" })).toBeVisible();
  });

  it("opens the closed panel on the chosen step", async () => {
    const user = userEvent.setup();
    const panel = await mount([reply(2, [tool("t1", "bash", { command: "make" }, "built")]), reply(4, [tool("s1", "web_search", { query: "pi" })])]);
    await user.click(within(panel).getByRole("button", { name: "Close computer" }));
    expect(screen.queryByRole("complementary", { name: "Computer" })).not.toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "View in computer" })[0]);
    const reopened = await screen.findByRole("complementary", { name: "Computer" });
    expect(within(windowOf(reopened)).getByRole("log", { name: "Terminal output" })).toHaveTextContent("$ make");
  });

  it("shows the latest reply's last step after a reload, noting clipped arguments", async () => {
    const clipped = tool("w9", "write", { _preview: '{"path":"notes/big.md","content":"line one\\nline tw' });
    const panel = await mount([reply(2, [tool("t1", "bash", { command: "make" })]), reply(3), reply(4, [tool("t2", "bash", { command: "ls" }), clipped])]);
    const win = windowOf(panel);
    expect(within(win).getByText("big.md")).toBeVisible();
    expect(within(win).getByText("line one")).toBeVisible();
    expect(within(win).getByText("Only part of this step was kept")).toBeVisible();
    expect(within(panel).getByText("Write big.md")).toBeVisible();
    expect(within(panel).getByText("2 / 2")).toBeVisible();
    // The status under the window (the file header inside it repeats the step state).
    expect(within(panel).getAllByText("Done").filter((node) => !win.contains(node))).toHaveLength(1);
    expect(within(panel).queryByRole("button", { name: /back to/i })).not.toBeInTheDocument();
  });

  it("pins the live browser while a person holds it and resumes following after handing back", async () => {
    const user = userEvent.setup();
    tabs = [{ tabId: "t1", url: "https://example.com/login", title: "Login" }];
    const panel = await mount();
    step("b1", "bash", { command: "echo one" });
    step("b2", "bash", { command: "echo two" });
    expect(within(windowOf(panel)).getByRole("log", { name: "Terminal output" })).toBeVisible();

    await user.click(within(panel).getByRole("button", { name: "Take control" }));
    const viewer = await screen.findByRole("dialog", { name: "Login" });
    expect(within(viewer).getByRole("img", { name: "Browser screen: Login" })).toBeVisible();
    expect(within(windowOf(panel)).getByRole("img", { name: "Browser screen: Login" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Previous step" })).toBeDisabled();
    expect(within(panel).getByRole("slider", { name: "Step" })).toHaveAttribute("aria-disabled", "true");

    step("b3", "bash", { command: "echo three" });
    expect(within(windowOf(panel)).queryByRole("log")).not.toBeInTheDocument();

    await user.click(within(viewer).getByRole("button", { name: "Hand back to agent" }));
    await user.keyboard("{Escape}");
    expect(await within(windowOf(panel)).findByRole("log", { name: "Terminal output" })).toHaveTextContent("$ echo three");
    expect(within(panel).getByRole("button", { name: "Previous step" })).toBeEnabled();
  });

  it("opens the expanded viewer with the same step and the playback bar", async () => {
    const user = userEvent.setup();
    const panel = await mount();
    step("b1", "bash", { command: "pwd" }, "/workspace");
    step("w1", "write", { path: "a.txt", content: "alpha" });
    await user.click(within(windowOf(panel)).getByRole("button", { name: "Expand" }));
    const viewer = await screen.findByRole("dialog", { name: "Write a.txt" });
    expect(within(viewer).getByText("alpha")).toBeVisible();
    await user.click(within(viewer).getByRole("button", { name: "Previous step" }));
    expect(within(viewer).getByRole("log", { name: "Terminal output" })).toHaveTextContent(/\$ pwd\s*\/workspace/);
  });

  it("decodes escaped quotes, newlines and unicode split across deltas", async () => {
    const panel = await mount();
    emit({ type: "tool_input_start", tool_call_id: "w1", name: "write" });
    input("w1", '{"path":"q.txt","content":"say \\');
    input("w1", '"hi\\');
    input("w1", '"\\nnext \\u00');
    const win = windowOf(panel);
    expect(within(win).getByText('say "hi"')).toBeVisible();
    expect(within(win).getByText("next")).toBeVisible();
    input("w1", 'e9\\\\n"}');
    expect(within(win).getByText("next é\\n")).toBeVisible();
  });
});
