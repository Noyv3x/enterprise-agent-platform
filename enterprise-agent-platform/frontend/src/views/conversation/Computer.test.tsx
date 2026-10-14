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
/** Delivers one event; a stream delta waits for its animation frame, which follows at once here. */
function emit(event: Record<string, unknown> & { type: string }) {
  act(() => {
    const frames: FrameRequestCallback[] = [];
    const frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => -frames.push(callback));
    FakeEventSource.instances[0].dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify({ seq: ++seq, ...event }), lastEventId: String(seq) }));
    frame.mockRestore();
    for (const callback of frames) callback(performance.now());
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

/** Pi edit's `details.patch` (4 lines of context) and a write's patch for a new file. */
const EDIT_PATCH = "--- app.py\n+++ app.py\n@@ -8,4 +8,4 @@\n def total(rows):\n-    return sum(rows)\n+    return round(sum(rows), 2)\n \n print(total([1, 2]))\n\\ No newline at end of file\n";
const WRITE_PATCH = "--- notes.md\n+++ notes.md\n@@ -0,0 +1,2 @@\n+# 周报\n+完成\n";

/** The old and new line numbers in the gutters of the patch row holding `code`. */
function numbers(code: HTMLElement): string[] {
  return Array.from(code.parentElement!.querySelectorAll(":scope > span[aria-hidden]"), (span) => span.textContent ?? "");
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
    if (path === "/api/tasks") return { tasks: [] };
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

  it("is one window with no step-view switcher, the live browser when there is no step", async () => {
    tabs = [{ tabId: "t1", url: "https://example.com/", title: "Example" }];
    const panel = await mount();
    expect(within(panel).getAllByRole("region", { name: "Computer screen" })).toHaveLength(1);
    // The side window's only tabs choose between Artifacts and Computer.
    expect(within(panel).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Artifacts", "Computer"]);
    expect(within(panel).queryByRole("button", { name: /follow/i })).not.toBeInTheDocument();
    expect(await within(windowOf(panel)).findByRole("img", { name: "Browser screen: Example" })).toBeVisible();
    expect(within(windowOf(panel)).getByText("https://example.com/")).toBeVisible();
    expect(within(panel).getByText("Idle")).toBeVisible();
    // Fewer than two steps: nothing to play back.
    expect(within(panel).getByRole("slider", { name: "Step" })).toHaveAttribute("aria-disabled", "true");
    expect(within(panel).getByRole("button", { name: "Previous step" })).toBeDisabled();
  });

  it("opens each segment's tool in the same live run and persisted reply", async () => {
    const user = userEvent.setup();
    const panel = await mount();
    step("before-input", "read", { path: "/workspace/before.txt" }, "Before the insertion");
    emit({ type: "input_delivered", message_id: 7 });
    step("after-input", "read", { path: "/workspace/after.txt" }, "After the insertion");
    const live = screen.getByRole("article", { name: "Reply in progress" });
    await user.click(within(live).getByRole("button", { name: /^Worked for/ }));
    const liveActions = within(live).getAllByRole("button", { name: "View in computer" });
    expect(liveActions).toHaveLength(2);
    await user.click(liveActions[0]);
    expect(within(windowOf(panel)).getByText("Before the insertion")).toBeVisible();
    expect(within(panel).getByText("1 / 2")).toBeVisible();
    await user.click(liveActions[1]);
    expect(within(windowOf(panel)).getByText("After the insertion")).toBeVisible();
    expect(within(panel).getByText("2 / 2")).toBeVisible();

    const finished = reply(40, [
      tool("before-input", "read", { path: "/workspace/before.txt" }, "Before the insertion"),
      { type: "input", message_id: 7, at: "2026-10-01T05:22:06Z" },
      tool("after-input", "read", { path: "/workspace/after.txt" }, "After the insertion"),
    ]);
    emit({ type: "run_end", message: finished });
    const settled = screen.getByRole("article", { name: "Agent reply" });
    for (const header of within(settled).getAllByRole("button", { name: /^Worked for/ })) await user.click(header);
    const persistedActions = within(settled).getAllByRole("button", { name: "View in computer" });
    expect(persistedActions).toHaveLength(2);
    await user.click(persistedActions[0]);
    expect(within(windowOf(panel)).getByText("Before the insertion")).toBeVisible();
    expect(within(panel).getByText("1 / 2")).toBeVisible();
    await user.click(persistedActions[1]);
    expect(within(windowOf(panel)).getByText("After the insertion")).toBeVisible();
    expect(within(panel).getByText("2 / 2")).toBeVisible();
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

  it("shows a finished edit and write as their unified patch with old and new line numbers", async () => {
    const panel = await mount();
    emit({ type: "tool_input_start", tool_call_id: "e1", name: "edit" });
    emit({ type: "tool_start", tool_call_id: "e1", name: "edit", args: { path: "app.py", edits: [{ oldText: "    return sum(rows)", newText: "    return round(sum(rows), 2)" }] } });
    // While it runs: the arguments as removed and added blocks.
    expect(within(windowOf(panel)).getByText("return sum(rows)")).toBeVisible();
    emit({ type: "tool_end", tool_call_id: "e1", is_error: false, content_preview: text("Successfully replaced 1 block(s) in app.py."),
      details: { patch: EDIT_PATCH, diff: " 8 def total(rows):\n-9     return sum(rows)\n+9     return round(sum(rows), 2)", firstChangedLine: 9 } });
    let win = windowOf(panel);
    expect(within(win).getByText("@@ -8,4 +8,4 @@")).toBeVisible();
    expect(numbers(within(win).getByText("def total(rows):"))).toEqual(["8", "8"]);
    expect(numbers(within(win).getByText("return sum(rows)"))).toEqual(["9", ""]);
    expect(numbers(within(win).getByText("return round(sum(rows), 2)"))).toEqual(["", "9"]);
    expect(numbers(within(win).getByText("print(total([1, 2]))"))).toEqual(["11", "11"]);
    expect(within(win).getByText("+1")).toBeVisible();
    expect(within(win).getByText("−1")).toBeVisible();
    // Pi's display diff never reaches the screen.
    expect(within(win).queryByText(/-9 {5}return/)).not.toBeInTheDocument();

    emit({ type: "tool_input_start", tool_call_id: "w1", name: "write" });
    emit({ type: "tool_start", tool_call_id: "w1", name: "write", args: { path: "notes.md", content: "# 周报\n完成\n" } });
    emit({ type: "tool_end", tool_call_id: "w1", is_error: false, content_preview: text("Successfully wrote to notes.md"), details: { patch: WRITE_PATCH } });
    win = windowOf(panel);
    expect(numbers(within(win).getByText("# 周报"))).toEqual(["", "1"]);
    expect(numbers(within(win).getByText("完成"))).toEqual(["", "2"]);
    expect(within(win).getByText("+2")).toBeVisible();
    expect(within(win).getByText("−0")).toBeVisible();
    expect(within(win).queryByText("Only part of this change is shown")).not.toBeInTheDocument();

    // Runtime cut a large patch on whole lines to fit its event budget and flagged it.
    emit({ type: "tool_input_start", tool_call_id: "w2", name: "write" });
    emit({ type: "tool_start", tool_call_id: "w2", name: "write", args: { path: "big.md", content: "# 周报\n完成\n" } });
    emit({ type: "tool_end", tool_call_id: "w2", is_error: false, content_preview: text("Successfully wrote to big.md"), details: { patch: WRITE_PATCH, patch_truncated: true } });
    expect(within(windowOf(panel)).getByText("Only part of this change is shown")).toBeVisible();
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
    const latest = reply(4, [{ ...tool("s1", "web_search", { query: "pi agent" }, ""), query: "pi agent", results: [{ title: "Pi agent docs", url: "https://pi.dev/docs", description: "Docs" }], unresponsive: [] }]);
    const panel = await mount([older, latest]);
    expect(within(windowOf(panel)).getByText("pi agent")).toBeVisible();
    const link = within(windowOf(panel)).getByRole("link", { name: "Pi agent docs" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));

    const [olderReply] = screen.getAllByRole("article", { name: "Agent reply" });
    await user.click(within(olderReply).getByRole("button", { name: "View in computer" }));
    expect(within(windowOf(panel)).getByRole("log", { name: "Terminal output" })).toHaveTextContent(/\$ make\s*built/);
    expect(within(panel).getByText("Run make")).toBeVisible();
    expect(within(panel).getByText("1 / 1")).toBeVisible();

    await user.click(within(panel).getByRole("button", { name: "Back to latest step" }));
    expect(within(windowOf(panel)).getByRole("link", { name: "Pi agent docs" })).toBeVisible();
  });

  describe("web steps", () => {
    const RESULTS = [
      { title: "NEV sales up 34%", url: "https://www.news.cn/a.html", description: "Production and sales both exceeded 11 million." },
      { title: "September auto sales", url: "https://www.reuters.com/x", description: "NEV sales rose 28%." },
    ];
    const PAGE = { url: "https://www.news.cn/a.html", title: "前三季度新能源汽车产销突破1100万辆", via: "direct", chars: 6842, truncated: false, excerpt: "## 渗透率\n\n9月当月达到 55.6%。\n\n![chart](https://cdn.example.com/c.png)" };
    const BLOCKED = { error: "blocked", url: "https://www.reuters.com/x", host: "www.reuters.com", status: 401, protection: "DataDome", tried_browser: true };
    const EXPLANATION = "Could not read www.reuters.com: blocked (HTTP 401, DataDome); a real browser was tried. Use another source.";
    /** The run as Platform persists it (platform-api.md § Assistant message work trace). */
    const PERSISTED = [
      { ...tool("s1", "web_search", { query: "新能源 销量" }, ""), query: "新能源 销量", results: RESULTS, unresponsive: [] },
      { ...tool("f1", "web_fetch", { url: PAGE.url }, ""), page: { url: PAGE.url, title: PAGE.title, via: "direct", chars: 6842, truncated: false }, excerpt: PAGE.excerpt },
      { ...tool("f2", "web_fetch", { url: BLOCKED.url }, EXPLANATION), status: "error", failure: { error: "blocked", host: "www.reuters.com", status: 401, protection: "DataDome", tried_browser: true } },
    ];

    function webStep(id: string, name: string, args: Record<string, unknown>, details: Record<string, unknown>, isError = false, output = "{}") {
      emit({ type: "tool_input_start", tool_call_id: id, name });
      emit({ type: "tool_start", tool_call_id: id, name, args });
      emit({ type: "tool_end", tool_call_id: id, is_error: isError, content_preview: text(output), details });
    }

    /** What the conversation and the computer show for the run, live or reloaded. */
    async function expectRun(panel: HTMLElement, article: HTMLElement, user: ReturnType<typeof userEvent.setup>) {
      // The window follows the latest step: the blocked page, explained calmly.
      let win = windowOf(panel);
      expect(within(win).getByRole("heading", { name: "reuters.com blocked automated access" })).toBeVisible();
      expect(within(win).getByText(/DataDome bot protection/)).toBeVisible();
      expect(within(win).getByText("A real browser was tried as well, without success.")).toBeVisible();
      expect(within(win).getByRole("link", { name: "Open the original page" })).toHaveAttribute("href", BLOCKED.url);
      // One group for the session; the blocked row explains instead of failing.
      expect(within(article).getByRole("button", { name: "1 search · 1 page read · 1 could not be opened" })).toBeVisible();
      expect(within(article).getByText("blocked automated access")).toBeVisible();
      expect(within(article).queryByText("Failed")).not.toBeInTheDocument();
      expect(within(article).getByText("2 results")).toBeVisible();
      expect(within(article).getByText(`news.cn · ${PAGE.title}`)).toBeVisible();

      const views = within(article).getAllByRole("button", { name: "View in computer" });
      await user.click(views[0]);
      win = windowOf(panel);
      const rows = within(within(win).getByLabelText("Search results")).getAllByRole("listitem");
      expect(within(rows[0]).getByRole("link", { name: RESULTS[0].title })).toHaveAttribute("target", "_blank");
      expect(within(rows[0]).getByText("Read")).toBeVisible();
      expect(within(rows[1]).getByText("Could not open")).toBeVisible();

      await user.click(views[1]);
      win = windowOf(panel);
      expect(within(win).getByRole("heading", { name: PAGE.title })).toBeVisible();
      expect(within(win).getByText("9月当月达到 55.6%。")).toBeVisible();
      // Page images never load.
      expect(win.querySelector("img")).toBeNull();
      expect(within(win).getByRole("link", { name: "Open the original" })).toHaveAttribute("href", PAGE.url);
    }

    it("shows the run live from tool_end details, then reads its sources under the settled reply", async () => {
      const user = userEvent.setup();
      const panel = await mount();
      webStep("s1", "web_search", { query: "新能源 销量" }, { query: "新能源 销量", web: RESULTS.map((result, at) => ({ ...result, position: at + 1 })), source: "managed_search", unresponsive: [] });
      webStep("f1", "web_fetch", { url: PAGE.url }, PAGE);
      emit({ type: "tool_input_start", tool_call_id: "f2", name: "web_fetch" });
      emit({ type: "tool_start", tool_call_id: "f2", name: "web_fetch", args: { url: BLOCKED.url } });
      expect(screen.getByRole("button", { name: /^Reading reuters\.com/ })).toBeVisible();
      emit({ type: "tool_end", tool_call_id: "f2", is_error: true, content_preview: text(EXPLANATION), details: BLOCKED });
      await expectRun(panel, screen.getByRole("article", { name: "Reply in progress" }), user);
      // Still streaming: no sources yet.
      expect(screen.queryByRole("button", { name: "1 source" })).not.toBeInTheDocument();

      emit({ type: "run_end", message: reply(5, PERSISTED) });
      const settled = screen.getByRole("article", { name: "Agent reply" });
      const sources = within(settled).getByRole("button", { name: "1 source" });
      expect(sources).toHaveAttribute("aria-expanded", "false");
      await user.click(sources);
      expect(sources).toHaveAttribute("aria-expanded", "true");
      // Only the page actually read is a source; the blocked one is not.
      const links = within(document.getElementById(sources.getAttribute("aria-controls")!)!).getAllByRole("link");
      expect(links.map((link) => [link.getAttribute("href"), link.getAttribute("target")])).toEqual([[PAGE.url, "_blank"]]);
      expect(links[0]).toHaveAccessibleName(expect.stringContaining(PAGE.title));
    });

    it("renders a reloaded run exactly like the live one", async () => {
      const user = userEvent.setup();
      const panel = await mount([reply(5, PERSISTED)]);
      const article = screen.getByRole("article", { name: "Agent reply" });
      await user.click(within(article).getByRole("button", { name: /^Worked for/ }));
      await expectRun(panel, article, user);
      expect(within(article).getByRole("button", { name: "1 source" })).toBeVisible();
    });

    it("names a page the site refused calmly in the status pill and announcement, while real failures stay red", async () => {
      const user = userEvent.setup();
      const panel = await mount();
      const announced = () => screen.getAllByRole("status").map((node) => node.textContent);
      const NOT_FOUND = { error: "not_found", url: "https://news.cn/gone", host: "news.cn", status: 404, tried_browser: false };
      webStep("f1", "web_fetch", { url: BLOCKED.url }, BLOCKED, true, EXPLANATION);
      expect(announced()).toContain("The site blocked the page");
      webStep("f2", "web_fetch", { url: NOT_FOUND.url }, NOT_FOUND, true, "Not found");
      expect(announced()).toContain("The page could not be opened");
      // A gateway failure without the contract's explanation is a real failure.
      emit({ type: "tool_input_start", tool_call_id: "f3", name: "web_fetch" });
      emit({ type: "tool_start", tool_call_id: "f3", name: "web_fetch", args: { url: "https://example.com/" } });
      emit({ type: "tool_end", tool_call_id: "f3", is_error: true, content_preview: text("Platform tool HTTP 502"), details: null });
      expect(announced()).toContain("Step failed");
      const live = screen.getByRole("article", { name: "Reply in progress" });
      expect(within(live).getAllByText("Failed")).toHaveLength(1);

      // Reviewing each step shows its pill.
      const views = within(live).getAllByRole("button", { name: "View in computer" });
      await user.click(views[0]);
      expect(within(panel).getByText("Blocked")).not.toHaveClass("bg-red-tint");
      expect(within(panel).queryByText("Failed")).not.toBeInTheDocument();
      await user.click(views[1]);
      expect(within(panel).getByText("Couldn't open")).not.toHaveClass("bg-red-tint");
      await user.click(views[2]);
      expect(within(panel).getByText("Failed")).toHaveClass("bg-red-tint");
    });

    it("names the engines that were unavailable when a search found nothing", async () => {
      const panel = await mount([reply(4, [{ ...tool("s1", "web_search", { query: "新能源" }, ""), query: "新能源", results: [], unresponsive: [{ engine: "baidu", reason: "CAPTCHA" }, { engine: "brave", reason: "too many requests" }] }])]);
      const win = windowOf(panel);
      expect(within(win).getByText("No results came back")).toBeVisible();
      expect(within(win).getByText("These engines are unavailable right now: baidu (CAPTCHA), brave (too many requests).")).toBeVisible();
      expect(within(screen.getByRole("article", { name: "Agent reply" })).getByText("No results", { exact: true })).toBeInTheDocument();
    });

    it("keeps older traces readable: a cut JSON output and an unexplained failure", async () => {
      const user = userEvent.setup();
      const panel = await mount([reply(4, [
        tool("s1", "web_search", { query: "pi" }, '{"web":[{"title":"Pi docs","url":"https://pi.dev/docs","description":"The agent'),
        { ...tool("f1", "web_fetch", { url: "https://www.reuters.com/x" }, 'Platform tool HTTP 502: {"error":"Tool upstream request failed"}'), status: "error" },
      ])]);
      let win = windowOf(panel);
      expect(within(win).getByRole("heading", { name: "reuters.com could not be opened" })).toBeVisible();
      expect(within(win).getByText(/Tool upstream request failed/)).toBeVisible();
      await user.click(screen.getAllByRole("button", { name: "View in computer" })[0]);
      win = windowOf(panel);
      expect(within(win).getByRole("link", { name: "Pi docs" })).toHaveAttribute("href", "https://pi.dev/docs");
    });
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

  it("shows the same patch after a reload from the persisted work trace, noting a clipped one", async () => {
    const user = userEvent.setup();
    const panel = await mount([reply(5, [
      { ...tool("e1", "edit", { path: "app.py", edits: [{ oldText: "    return sum(rows)", newText: "    return round(sum(rows), 2)" }] }), patch: EDIT_PATCH },
      { ...tool("w1", "write", { path: "notes.md", content: "# 周报\n完成\n" }), patch: WRITE_PATCH.split("\n").slice(0, 4).join("\n") + "\n", patch_truncated: true },
    ])]);
    let win = windowOf(panel);
    expect(numbers(within(win).getByText("# 周报"))).toEqual(["", "1"]);
    expect(within(win).queryByText("完成")).not.toBeInTheDocument();
    expect(within(win).getByText("Only part of this change is shown")).toBeVisible();
    await user.click(within(panel).getByRole("button", { name: "Previous step" }));
    win = windowOf(panel);
    expect(numbers(within(win).getByText("return round(sum(rows), 2)"))).toEqual(["", "9"]);
    expect(numbers(within(win).getByText("print(total([1, 2]))"))).toEqual(["11", "11"]);
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
