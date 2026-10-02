// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShellContext } from "../../components/ui/beautiful/controls";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { Conversation } from "../Conversation";
import type { Message } from "./types";

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

function reply(id: number, work?: Record<string, unknown>): Message {
  return { id, role: "assistant", content: "Done.", metadata: { status: "completed", ...(work ? { work } : {}) }, created_at: "2026-10-01T05:22:12Z", attachments: [] };
}

async function mount(messages: Message[] = []) {
  api.request.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/conversations/private/messages")) return { messages, next_before_id: null, last_seq: 0, compaction: null };
    if (path === "/api/browser") return { tabs: [], lease: null };
    if (path.startsWith("/api/workspace/files")) return { files: [] };
    throw new Error(`unexpected ${path}`);
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

describe("Computer panel", () => {
  beforeEach(() => {
    seq = 0;
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("grows a streaming write in the editor and switches the panel to it", async () => {
    const panel = await mount();
    expect(within(panel).getByRole("region", { name: "Browser" })).toBeVisible();

    emit({ type: "tool_input_start", tool_call_id: "w1", name: "write" });
    input("w1", '{"path":"src/app.ts","content":"const a = 1;\\nconst b');
    const editor = await within(panel).findByRole("region", { name: "Editor" });
    expect(within(panel).queryByRole("region", { name: "Browser" })).not.toBeInTheDocument();
    expect(within(editor).getByText("src/app.ts")).toBeVisible();
    expect(within(editor).getByText("const a = 1;")).toBeVisible();
    expect(within(editor).getByText("const b")).toBeVisible();
    expect(within(editor).getByText("Writing")).toBeVisible();

    input("w1", ' = 2;\\nconst c = 3;"}');
    expect(within(editor).getByText("const b = 2;")).toBeVisible();
    expect(within(editor).getByText("const c = 3;")).toBeVisible();

    // The authoritative arguments replace the parsed stream; the call finishes.
    emit({ type: "tool_start", tool_call_id: "w1", name: "write", args: { path: "src/app.ts", content: "final 1\nfinal 2" } });
    expect(within(editor).getByText("final 2")).toBeVisible();
    emit({ type: "tool_end", tool_call_id: "w1", name: "write", is_error: false, content_preview: text("ok"), details: null });
    expect(within(editor).getByText("Done")).toBeVisible();
  });

  it("appends live bash output in the terminal and replaces it with the final output at tool_end", async () => {
    const panel = await mount();
    emit({ type: "tool_input_start", tool_call_id: "b1", name: "bash" });
    emit({ type: "tool_start", tool_call_id: "b1", name: "bash", args: { command: "npm test" } });
    const terminal = await within(panel).findByRole("region", { name: "Terminal" });
    const log = within(terminal).getByRole("log", { name: "Terminal output" });
    expect(log).toHaveTextContent("$ npm test");
    expect(within(log).getByRole("img", { name: "Running" })).toBeInTheDocument();

    emit({ type: "tool_output", tool_call_id: "b1", delta: "compiling\n" });
    emit({ type: "tool_output", tool_call_id: "b1", delta: "3 passed\n" });
    expect(log).toHaveTextContent(/compiling\s*3 passed/);
    // Appended text is never announced.
    expect(log).toHaveAttribute("aria-live", "off");

    emit({ type: "tool_end", tool_call_id: "b1", name: "bash", is_error: true, content_preview: text("FINAL: 1 failed"), details: null });
    expect(log).toHaveTextContent("FINAL: 1 failed");
    expect(log).not.toHaveTextContent("compiling");
    expect(within(log).getByRole("img", { name: "Failed" })).toBeInTheDocument();
    expect(within(panel).getByRole("status")).toHaveTextContent("Command failed");
  });

  it("shows other tools as one line each", async () => {
    const panel = await mount();
    emit({ type: "tool_start", tool_call_id: "s1", name: "web_search", args: { query: "pi agent" } });
    emit({ type: "tool_end", tool_call_id: "s1", name: "web_search", is_error: false, content_preview: text("3 results"), details: null });
    emit({ type: "tool_start", tool_call_id: "g1", name: "grep", args: { pattern: "TODO", path: "src" } });
    const log = await within(panel).findByRole("log", { name: "Terminal output" });
    expect(log).toHaveTextContent('› web_search "pi agent"');
    expect(log).toHaveTextContent("3 results");
    expect(log).toHaveTextContent("$ grep -rn TODO src");
  });

  it("stops following after a manual view choice until Follow AI is pressed", async () => {
    const user = userEvent.setup();
    const panel = await mount();
    emit({ type: "tool_start", tool_call_id: "b1", name: "bash", args: { command: "ls" } });
    await within(panel).findByRole("region", { name: "Terminal" });

    await user.click(within(panel).getByRole("tab", { name: "Editor" }));
    expect(within(panel).getByRole("region", { name: "Editor" })).toBeVisible();
    emit({ type: "tool_start", tool_call_id: "b2", name: "bash", args: { command: "pwd" } });
    emit({ type: "tool_start", tool_call_id: "r1", name: "read", args: { path: "a.md" } });
    expect(within(panel).getByRole("region", { name: "Editor" })).toBeVisible();

    await user.click(within(panel).getByRole("button", { name: "Follow AI" }));
    expect(within(panel).getByRole("region", { name: "Editor" })).toBeVisible();
    emit({ type: "tool_start", tool_call_id: "b3", name: "bash", args: { command: "date" } });
    expect(await within(panel).findByRole("region", { name: "Terminal" })).toBeVisible();
    expect(within(panel).queryByRole("button", { name: "Follow AI" })).not.toBeInTheDocument();

    // A new run also resumes following.
    await user.click(within(panel).getByRole("tab", { name: "Browser" }));
    emit({ type: "run_end", message: reply(2) });
    emit({ type: "tool_start", tool_call_id: "e1", name: "edit", args: { path: "a.md", edits: [{ oldText: "x", newText: "y" }] } });
    expect(await within(panel).findByRole("region", { name: "Editor" })).toBeVisible();
  });

  it("keeps the last step after the run ends", async () => {
    const panel = await mount();
    emit({ type: "tool_input_start", tool_call_id: "e1", name: "edit" });
    input("e1", '{"path":"a.md","edits":[{"oldText":"old line","newText":"new li');
    const editor = await within(panel).findByRole("region", { name: "Editor" });
    expect(within(editor).getByText("old line")).toBeVisible();
    expect(within(editor).getByText("new li")).toBeVisible();
    emit({ type: "tool_start", tool_call_id: "e1", name: "edit", args: { path: "a.md", edits: [{ oldText: "old line", newText: "new line" }] } });
    emit({ type: "tool_end", tool_call_id: "e1", name: "edit", is_error: false, content_preview: text("ok"), details: { diff: "--- a.md\n+++ a.md\n@@ -1 +1 @@\n-old line\n+new line" } });
    emit({ type: "run_end", message: reply(2) });
    await waitFor(() => expect(within(panel).getByText("Idle")).toBeVisible());
    const kept = within(panel).getByRole("region", { name: "Editor" });
    expect(within(kept).getByText("new line")).toBeVisible();
    expect(within(kept).getByText("a.md", { selector: "span.font-mono" })).toBeVisible();
  });

  it("uses the latest reply's persisted work trace after a reload", async () => {
    const work = {
      v: 1, started_at: "2026-10-01T05:22:00Z", ended_at: "2026-10-01T05:22:12Z", truncated: false,
      items: [
        { type: "tool", id: "t1", name: "bash", args: { command: "make" }, status: "done", output: "built", started_at: "2026-10-01T05:22:01Z", ended_at: "2026-10-01T05:22:02Z" },
        { type: "tool", id: "t2", name: "write", args: { path: "notes/todo.md", content: "- one\n- two" }, status: "done", output: "", started_at: "2026-10-01T05:22:03Z", ended_at: "2026-10-01T05:22:04Z" },
      ],
    };
    const panel = await mount([reply(2, work)]);
    const editor = await within(panel).findByRole("region", { name: "Editor" });
    expect(within(editor).getByText("notes/todo.md")).toBeVisible();
    expect(within(editor).getByText("- two")).toBeVisible();
    await userEvent.setup().click(within(panel).getByRole("tab", { name: "Terminal" }));
    expect(within(panel).getByRole("log", { name: "Terminal output" })).toHaveTextContent(/\$ make\s*built/);
  });

  it("shows the browser when there is no activity at all", async () => {
    const panel = await mount();
    expect(within(panel).getByRole("region", { name: "Browser" })).toBeVisible();
    expect(within(panel).queryByRole("button", { name: "Follow AI" })).not.toBeInTheDocument();
  });

  it("decodes escaped quotes, newlines and unicode split across deltas", async () => {
    const panel = await mount();
    emit({ type: "tool_input_start", tool_call_id: "w1", name: "write" });
    input("w1", '{"path":"q.txt","content":"say \\');
    input("w1", '"hi\\');
    input("w1", '"\\nnext \\u00');
    const editor = await within(panel).findByRole("region", { name: "Editor" });
    expect(within(editor).getByText('say "hi"')).toBeVisible();
    expect(within(editor).getByText("next")).toBeVisible();
    input("w1", 'e9\\\\n"}');
    expect(within(editor).getByText("next é\\n")).toBeVisible();
  });
});
