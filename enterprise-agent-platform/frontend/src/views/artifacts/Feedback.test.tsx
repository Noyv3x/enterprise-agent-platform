// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactFeedback, ArtifactPreview, ArtifactVersion, ArtifactView } from "../../api";
import { ShellContext } from "../../components/ui/beautiful/controls";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { Conversation } from "../Conversation";
import type { Message } from "../conversation/types";
import { STORAGE_CAP_BYTES } from "./frameStorage";

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
    FakeEventSource.instances[FakeEventSource.instances.length - 1].dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify({ seq: ++seq, ...event }), lastEventId: String(seq) }));
  });
}

interface Stored { view: ArtifactView; versions: ArtifactVersion[]; preview?: ArtifactPreview }
let store: Record<number, Stored> = {};
let minted = 0;
let captured = 0;

const ENTRIES: Partial<Record<ArtifactView["kind"], string>> = { web: "deck.html", markdown: "notes.md" };

function publishOnServer(id: number, version: number, title = "Launch deck", kind: ArtifactView["kind"] = "web"): ArtifactView {
  const entry = ENTRIES[kind] ?? "deck.html";
  const view: ArtifactView = {
    id, scope: "chat-c1", path: `/workspace/c1/${entry}`, kind, title, entry, latest_version: version,
    created_at: "2026-10-12T01:00:00Z", updated_at: `2026-10-12T0${version}:00:00Z`,
  };
  const versions = Array.from({ length: version }, (_, index) => ({
    version: index + 1, entry, created_at: `2026-10-12T0${index + 1}:00:00Z`, total_size: 100, file_count: 1, message_id: null,
  }));
  store[id] = { view, versions };
  return view;
}

function publish(id: number, version: number, title?: string, kind?: ArtifactView["kind"]) {
  emit({ type: "artifact", artifact: publishOnServer(id, version, title, kind), version });
}

const LIVE: ArtifactView = {
  id: 21, scope: "private", path: "dev-site", kind: "live", title: "Shop preview", entry: null, latest_version: 0,
  created_at: "2026-10-12T01:00:00Z", updated_at: "2026-10-12T01:00:00Z",
};

function preview(state: ArtifactPreview["state"], task_id: string | null = "bg-3", revoked = false): ArtifactPreview {
  return { state, base_path: "/artifact-live/p0f3/", path: "/", service: "web", task_id: state === "waiting" ? null : task_id, revoked };
}

/** A live preview changes on the server and the stream says so: by a `preview` tool call, or by a state change. */
function previewState(state: ArtifactPreview["state"], task_id?: string | null, revoked?: boolean, cause: "preview" | "state" = "state") {
  store[LIVE.id] = { view: LIVE, versions: [], preview: preview(state, task_id, revoked) };
  emit({ type: "artifact", artifact: LIVE, version: 0, preview: preview(state, task_id, revoked), cause });
}

/** What withdrawing a message returns (`DELETE …/messages/{id}`). */
let withdrawn: unknown = null;

function route(path: string, method: string, body: unknown, messages: Message[]): unknown {
  if (/^\/api\/(chat\/)?conversations\/[^/]+\/messages$/.test(path) && method === "POST") {
    const sent = body as { content: string; artifact_feedback?: ArtifactFeedback[] };
    return {
      message: {
        id: 50, role: "user", content: sent.content, created_at: "2026-10-12T05:00:00Z", attachments: [],
        metadata: { status: "queued", ...(sent.artifact_feedback ? { artifact_feedback: sent.artifact_feedback.map((item) => ({ ...item, title: store[item.artifact_id]?.view.title })) } : {}) },
      },
      job_id: 1,
    };
  }
  if (/^\/api\/(chat\/)?conversations\/[^/]+\/messages\/\d+$/.test(path) && method === "DELETE") return withdrawn;
  if (/^\/api\/(chat\/)?conversations\/[^/]+\/messages/.test(path)) return { messages, next_before_id: null, last_seq: 0, compaction: null };
  if (path.startsWith("/api/artifacts?scope=")) return { artifacts: Object.values(store).map((item) => item.view) };
  let match = /^\/api\/artifacts\/(\d+)$/.exec(path);
  if (match) {
    const item = store[Number(match[1])];
    if (!item) throw new Error("not found");
    return { artifact: item.view, versions: [...item.versions].reverse(), ...(item.preview ? { preview: item.preview } : {}) };
  }
  match = /^\/api\/artifacts\/(\d+)\/versions\/(\d+)\/view$/.exec(path);
  if (match && method === "POST") return { url: `/artifact-view/t${++minted}-${match[1]}-${match[2]}/${store[Number(match[1])].view.entry}`, expires_at: new Date(Date.now() + 7_200_000).toISOString() };
  if (/^\/api\/artifacts\/\d+\/versions\/\d+\/source/.test(path)) return { content: "# Plan\n\nShip the beta in May.\n", truncated: false, mime: "text/markdown" };
  if (/^\/api\/artifacts\/\d+\/(versions\/\d+|live)\/capture$/.test(path) && method === "POST") {
    const id = 900 + ++captured;
    return { attachment: { id, filename: `capture-${id}.png`, mime_type: "image/png", size_bytes: 2048, url: `/api/attachments/${id}`, preview_url: `/api/attachments/${id}/preview`, view_kind: "image" } };
  }
  if (/^\/api\/tasks\/bg-\d+\/stop$/.test(path) && method === "POST") return { task: { id: path.split("/")[3] } };
  if (path === "/api/artifacts/21/live" && method === "DELETE") {
    store[21] = { ...store[21], preview: { ...store[21].preview!, state: "stopped", revoked: true } };
    return { preview: store[21].preview };
  }
  if (path === "/api/tasks") return { tasks: [] };
  if (path === "/api/browser") return { tabs: [], lease: null };
  if (path.startsWith("/api/workspace/files")) return { files: [] };
  if (path.startsWith("/api/skills") || path.startsWith("/api/mcp/")) return { skills: [], prompts: [], connectors: [] };
  throw new Error(`unexpected ${method} ${path}`);
}

async function mount(scope: string, messages: Message[] = []) {
  api.request.mockImplementation(async (path: string, options: RequestInit = {}) =>
    route(path, options.method ?? "GET", typeof options.body === "string" ? JSON.parse(options.body) : undefined, messages));
  const aside = document.createElement("div");
  document.body.append(aside);
  render(
    <I18nProvider>
      <ShellContext.Provider value={{ narrow: false, openNavigation: () => undefined, asideSlot: aside }}>
        <Conversation scope={scope} canSend />
      </ShellContext.Provider>
    </I18nProvider>,
  );
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  await screen.findByRole("log", { name: "Conversation" }).catch(() => undefined);
}

function calls(method: string, path: string): unknown[] {
  return api.request.mock.calls
    .filter(([calledPath, options]) => calledPath === path && (options?.method ?? "GET") === method)
    .map(([, options]) => (typeof options?.body === "string" ? JSON.parse(options.body) : options?.body));
}

const frame = () => document.querySelector("iframe")!;
const artifactsPanel = () => screen.findByRole("complementary", { name: "Artifacts" });

/** A message from the page runtime, from the frame's window unless another source is given. */
function fromPage(data: Record<string, unknown>, source: MessageEventSource | null = frame().contentWindow) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source, origin: "null" }));
  });
}

const PICK = {
  type: "eap-pick", kind: "element", selector: "main > h2.title", tag: "h2", text: "Pricing that scales with you",
  rect: { x: 24, y: 640, w: 320, h: 48 }, path: "deck.html", scroll: { x: 0, y: 400 }, viewport: { w: 1280, h: 800 },
};
const REGION = { type: "eap-pick", kind: "region", rect: { x: 0, y: 0, w: 400, h: 300 }, path: "deck.html", scroll: { x: 0, y: 0 }, viewport: { w: 1280, h: 800 } };
/** A REGION pick of artifact 11 v1 as a message sends it. */
const REGION_FEEDBACK = { artifact_id: 11, version: 1, path: "deck.html", kind: "region", rect: REGION.rect };
const ELEMENT_LABEL = "Launch deck v1 · h2 · Pricing that scale…";

/** Opens a published web page in the panel with 圈选 on; returns the panel and the frame's postMessage spy. */
async function annotatePage() {
  const user = userEvent.setup();
  await mount("chat-c1");
  emit({ type: "text_delta", delta: "Building" });
  publish(11, 1);
  const panel = await artifactsPanel();
  await waitFor(() => expect(frame()).toHaveAttribute("src", "/artifact-view/t1-11-1/deck.html"));
  const post = vi.spyOn(frame().contentWindow!, "postMessage");
  fireEvent.load(frame());
  await user.click(within(panel).getByRole("button", { name: "Annotate" }));
  return { user, panel, post };
}

describe("圈选反馈", () => {
  beforeEach(() => {
    seq = 0;
    store = {};
    minted = 0;
    captured = 0;
    FakeEventSource.instances = [];
    api.request.mockReset();
    vi.stubGlobal("EventSource", FakeEventSource);
    window.localStorage.clear();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("turns the page inspector on and off, and ignores messages from other windows", async () => {
    const { user, panel, post } = await annotatePage();
    expect(post).toHaveBeenLastCalledWith({ type: "eap-inspect", on: true }, "*");
    expect(within(panel).getByRole("button", { name: "Annotate" })).toHaveAttribute("aria-pressed", "true");
    expect(within(panel).getByText("Click an element, or hold Shift and drag to select a region")).toBeVisible();

    // A reload of the page gets the state again.
    post.mockClear();
    fireEvent.load(frame());
    expect(post).toHaveBeenCalledWith({ type: "eap-inspect", on: true }, "*");

    // Another window (another frame, an extension, the app itself) cannot pick or end the inspector.
    fromPage(PICK, window);
    fromPage({ type: "eap-inspect-exit" }, window);
    expect(calls("POST", "/api/artifacts/11/versions/1/capture")).toEqual([]);
    expect(within(panel).getByRole("button", { name: "Annotate" })).toHaveAttribute("aria-pressed", "true");

    // Escape in the page ends it; the toggle turns it on and off too.
    fromPage({ type: "eap-inspect-exit" });
    expect(within(panel).getByRole("button", { name: "Annotate" })).toHaveAttribute("aria-pressed", "false");
    expect(post).toHaveBeenLastCalledWith({ type: "eap-inspect", on: false }, "*");
    await user.click(within(panel).getByRole("button", { name: "Annotate" }));
    expect(post).toHaveBeenLastCalledWith({ type: "eap-inspect", on: true }, "*");
    await user.click(within(panel).getByRole("button", { name: "Done" }));
    expect(post).toHaveBeenLastCalledWith({ type: "eap-inspect", on: false }, "*");

    // Off, a pick from the page does nothing.
    fromPage(PICK);
    expect(calls("POST", "/api/artifacts/11/versions/1/capture")).toEqual([]);
  });

  it("captures a picked element or region and adds a screenshot chip and a context chip for each", async () => {
    const { panel } = await annotatePage();
    fromPage(PICK);
    await waitFor(() => expect(calls("POST", "/api/artifacts/11/versions/1/capture")).toEqual([
      { path: "deck.html", rect: { x: 24, y: 640, w: 320, h: 48 }, viewport: { w: 1280, h: 800 } },
    ]));
    expect(await screen.findByRole("button", { name: `Remove Screenshot · ${ELEMENT_LABEL}` })).toBeVisible();
    expect(screen.getByRole("button", { name: `Remove ${ELEMENT_LABEL}` })).toBeVisible();
    expect(within(panel).getByRole("status", { name: "Feedback status" })).toHaveTextContent("Added to the message (1/5)");

    fromPage(REGION);
    expect(await screen.findByRole("button", { name: "Remove Screenshot · Launch deck v1 · Region" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove Launch deck v1 · Region" })).toBeVisible();
    expect(calls("POST", "/api/artifacts/11/versions/1/capture")).toHaveLength(2);

    // At most five wait; a sixth is refused before anything is captured.
    for (let n = 0; n < 4; n++) fromPage(REGION);
    expect(calls("POST", "/api/artifacts/11/versions/1/capture")).toHaveLength(5);
    expect(within(panel).getByRole("status", { name: "Feedback status" })).toHaveTextContent("5 notes already wait: send or remove some first");
  });

  it("removes a screenshot alone, or a context with its screenshot", async () => {
    const { user } = await annotatePage();
    fromPage(PICK);
    fromPage(REGION);
    await user.click(await screen.findByRole("button", { name: `Remove Screenshot · ${ELEMENT_LABEL}` }));
    expect(screen.queryByRole("button", { name: `Remove Screenshot · ${ELEMENT_LABEL}` })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Remove ${ELEMENT_LABEL}` })).toBeVisible();

    await user.click(await screen.findByRole("button", { name: "Remove Launch deck v1 · Region" }));
    expect(screen.queryByRole("button", { name: "Remove Launch deck v1 · Region" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Screenshot · Launch deck v1 · Region" })).not.toBeInTheDocument();
  });

  it("sends the feedback as artifact_feedback with its screenshots, and shows it in the bubble", async () => {
    const { user } = await annotatePage();
    fromPage(PICK);
    fromPage(REGION);
    await user.click(await screen.findByRole("button", { name: "Remove Launch deck v1 · Region" }));
    await screen.findByRole("button", { name: `Remove Screenshot · ${ELEMENT_LABEL}` });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
    await user.type(screen.getByRole("combobox", { name: "Message" }), "Make this heading bigger");
    await user.click(screen.getByRole("button", { name: "Send" }));

    // The run is still going, so the message joins it.
    expect(calls("POST", "/api/chat/conversations/c1/messages")).toEqual([{
      content: "Make this heading bigger",
      attachment_ids: [901],
      mode: "insert",
      artifact_feedback: [{
        artifact_id: 11, version: 1, path: "deck.html", kind: "element", selector: "main > h2.title", text: "Pricing that scales with you",
        rect: { x: 24, y: 640, w: 320, h: 48 },
      }],
    }]);
    await waitFor(() => expect(screen.queryByRole("button", { name: `Remove ${ELEMENT_LABEL}` })).not.toBeInTheDocument());
    expect(await screen.findByRole("button", { name: `Open ${ELEMENT_LABEL}` })).toBeVisible();
  });

  it("quotes selected text from a markdown artifact", async () => {
    const user = userEvent.setup();
    await mount("chat-c1");
    emit({ type: "text_delta", delta: "Writing" });
    publish(12, 1, "Notes", "markdown");
    const panel = await artifactsPanel();
    const line = await within(panel).findByText("Ship the beta in May.");
    await user.click(within(panel).getByRole("button", { name: "Annotate" }));
    expect(within(panel).getByText("Select text, then choose Quote in chat")).toBeVisible();

    act(() => {
      const range = document.createRange();
      range.selectNodeContents(line);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await user.click(await within(panel).findByRole("button", { name: "Quote in chat" }));
    expect(screen.getByRole("button", { name: "Remove Notes v1 · Quote · Ship the beta in M…" })).toBeVisible();
    expect(api.request.mock.calls.some(([path]) => String(path).endsWith("/capture"))).toBe(false);

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(calls("POST", "/api/chat/conversations/c1/messages")).toEqual([{
      content: "", attachment_ids: [], mode: "insert", artifact_feedback: [{ artifact_id: 12, version: 1, path: "notes.md", kind: "quote", text: "Ship the beta in May." }],
    }]);
  });

  it("opens the artifact version a sent message's feedback chip names", async () => {
    const user = userEvent.setup();
    publishOnServer(11, 3);
    const sent: Message = {
      id: 4, role: "user", content: "Fix the heading", created_at: "2026-10-12T05:00:00Z", attachments: [],
      metadata: { status: "completed", artifact_feedback: [
        { artifact_id: 11, version: 2, path: "deck.html", kind: "element", selector: "main > h2.title", text: "Pricing", title: "Launch deck", artifact_kind: "web" },
        { artifact_id: 11, version: 2, path: "deck.html", kind: "region", title: "Launch deck", artifact_kind: "web" },
      ] },
    };
    await mount("chat-c1", [sent]);
    expect(await screen.findByRole("button", { name: "Open Launch deck v2 · Region" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open Launch deck v2 · h2 · Pricing" }));
    const panel = await artifactsPanel();
    await waitFor(() => expect(frame()).toHaveAttribute("src", "/artifact-view/t1-11-2/deck.html"));
    expect(within(panel).getByRole("combobox", { name: "Version" })).toHaveTextContent(/^v2 ·/);
  });

  it("keeps a page's localStorage per artifact and seeds it into the next load", async () => {
    const user = userEvent.setup();
    await mount("chat-c1");
    emit({ type: "text_delta", delta: "Building" });
    publish(11, 1);
    const panel = await artifactsPanel();
    await waitFor(() => expect(frame()).toHaveAttribute("src", "/artifact-view/t1-11-1/deck.html"));

    fromPage({ type: "eap-storage", data: { other: "window" } }, window);
    fromPage({ type: "eap-storage", data: { todos: '["Ship 中文"]' } });
    expect(JSON.parse(window.localStorage.getItem("eap-artifact-storage:-:11")!)).toEqual({ t: expect.any(Number), data: { todos: '["Ship 中文"]' } });
    // A later snapshot does not reload the page.
    expect(frame()).toHaveAttribute("src", "/artifact-view/t1-11-1/deck.html");

    await user.click(within(panel).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(frame().getAttribute("src")).toMatch(/^\/artifact-view\/t2-11-1\/deck\.html#__eap=/));
    const encoded = frame().getAttribute("src")!.split("#__eap=")[1];
    expect(encoded).not.toMatch(/[+/=]/);
    const bytes = Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ todos: '["Ship 中文"]' });
    // The new tab gets no seed.
    expect(within(panel).getByRole("link", { name: "Open in new tab" })).toHaveAttribute("href", "/artifact-view/t2-11-1/deck.html");

    // A snapshot over the cap is not kept.
    fromPage({ type: "eap-storage", data: { big: "x".repeat(STORAGE_CAP_BYTES) } });
    expect(window.localStorage.getItem("eap-artifact-storage:-:11")).toBeNull();
  });

  it("shows a live preview waiting, running, stopped and resumed, stops its service and ends the preview after confirming", async () => {
    const user = userEvent.setup();
    await mount("private");
    emit({ type: "text_delta", delta: "Starting the dev server" });
    previewState("waiting", null, false, "preview");
    const live = screen.getByRole("article", { name: "Reply in progress" });
    expect(within(live).getByRole("button", { name: "Open Shop preview, Live preview · Waiting to start" })).toBeVisible();

    const panel = await artifactsPanel();
    expect(await within(panel).findByText("Waiting to start")).toBeVisible();
    expect(within(panel).getByText("The site opens here once web is running.")).toBeVisible();
    expect(document.querySelector("iframe")).toBeNull();
    expect(within(panel).queryByRole("combobox", { name: "Version" })).not.toBeInTheDocument();

    previewState("running");
    expect(await within(panel).findByText("Running")).toBeVisible();
    await waitFor(() => expect(frame()).toHaveAttribute("src", "/artifact-live/p0f3/"));
    expect(frame()).toHaveAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads");
    expect(within(panel).getByRole("link", { name: "Open in new tab" })).toHaveAttribute("href", "/artifact-live/p0f3/");
    expect(within(panel).getByRole("tab", { name: "Phone" })).toBeVisible();
    expect(within(panel).getByRole("button", { name: "Annotate" })).toBeVisible();

    // A pick in the live page captures through the live route.
    fireEvent.load(frame());
    await user.click(within(panel).getByRole("button", { name: "Annotate" }));
    fromPage({ ...PICK, path: "cart" });
    await waitFor(() => expect(calls("POST", "/api/artifacts/21/live/capture")).toEqual([
      { path: "cart", rect: PICK.rect, viewport: PICK.viewport },
    ]));
    expect(await screen.findByRole("button", { name: "Remove Shop preview · h2 · Pricing that scale…" })).toBeVisible();

    // 停止服务 asks first; keeping it running sends nothing.
    await user.click(within(panel).getByRole("button", { name: "Stop service" }));
    let dialog = await screen.findByRole("alertdialog", { name: "Stop this service?" });
    await user.click(within(dialog).getByRole("button", { name: "Keep running" }));
    expect(calls("POST", "/api/tasks/bg-3/stop")).toEqual([]);
    await user.click(within(panel).getByRole("button", { name: "Stop service" }));
    dialog = await screen.findByRole("alertdialog", { name: "Stop this service?" });
    await user.click(within(dialog).getByRole("button", { name: "Stop service" }));
    await waitFor(() => expect(calls("POST", "/api/tasks/bg-3/stop")).toEqual([{}]));

    // The run settles into a reply that keeps the card; the service stops after it: the state changes, no new reply.
    emit({ type: "run_end", message: {
      id: 30, role: "assistant", content: "The shop is running.", created_at: "2026-10-12T05:00:00Z", attachments: [],
      metadata: { status: "completed", artifacts: [{ id: 21, version: 0, title: "Shop preview", kind: "live", path: "live:web" }] },
    } });
    previewState("stopped");
    expect(await within(panel).findByText("The service has stopped")).toBeVisible();
    expect(within(panel).getByText("The site shows here again, at the same link, once the AI starts web again.")).toBeVisible();
    expect(within(panel).getByText("Stopped")).toBeVisible();
    expect(document.querySelector("iframe")).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Stop service" })).not.toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Reply in progress" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Shop preview, Live preview · Stopped" })).toBeVisible();

    // The service starts again in a later run (a state change, not a preview call): the same link comes back, with the
    // new task to stop, and the run gets no card.
    emit({ type: "text_delta", delta: "Restarting" });
    previewState("running", "bg-4");
    await waitFor(() => expect(frame()).toHaveAttribute("src", "/artifact-live/p0f3/"));
    expect(screen.getAllByRole("button", { name: "Open Shop preview, Live preview · Running" })).toHaveLength(1);
    expect(within(screen.getByRole("article", { name: "Reply in progress" })).queryByRole("button", { name: /^Open Shop preview/ })).not.toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Stop service" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "Stop this service?" })).getByRole("button", { name: "Stop service" }));
    await waitFor(() => expect(calls("POST", "/api/tasks/bg-4/stop")).toEqual([{}]));

    // 结束预览 asks first, says the link stops working, and revokes it (the service is not stopped).
    await user.click(within(panel).getByRole("button", { name: "End preview" }));
    dialog = await screen.findByRole("alertdialog", { name: "End this preview?" });
    expect(dialog).toHaveTextContent("The link will stop working");
    await user.click(within(dialog).getByRole("button", { name: "Keep preview" }));
    expect(calls("DELETE", "/api/artifacts/21/live")).toEqual([]);
    await user.click(within(panel).getByRole("button", { name: "End preview" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "End this preview?" })).getByRole("button", { name: "End preview" }));
    await waitFor(() => expect(calls("DELETE", "/api/artifacts/21/live")).toHaveLength(1));
    expect(calls("POST", "/api/tasks/bg-4/stop")).toHaveLength(1);
    previewState("stopped", "bg-4", true);
    expect(await within(panel).findByText("This preview has ended")).toBeVisible();
    expect(within(panel).getByText("Ended")).toBeVisible();
    expect(document.querySelector("iframe")).toBeNull();
    expect(within(panel).queryByRole("button", { name: "End preview" })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Stop service" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Shop preview, Live preview · Ended" })).toBeVisible();
    await user.click(within(panel).getByRole("button", { name: "All artifacts" }));
    expect(within(panel).getByRole("button", { name: /^Shop preview/ })).toHaveTextContent("Live preview · Ended");
  });

  it("puts a withdrawn message's feedback back in the composer, with its screenshots, up to five", async () => {
    const user = userEvent.setup();
    const stored = (n: number) => ({
      artifact_id: 11, version: 1, path: "deck.html", kind: "element", selector: `main > h${n}`, text: `Heading ${n}`, rect: { x: n, y: 10, w: 100, h: 20 },
      title: "Launch deck", artifact_kind: "web", artifact_path: "/workspace/c1/deck.html",
    });
    withdrawn = {
      content: "Fix these headings",
      attachments: [{ id: 77, filename: "capture-77.png", mime_type: "image/png", size_bytes: 2048, url: "/api/attachments/77", preview_url: "/api/attachments/77/preview", view_kind: "image" }],
      artifact_feedback: [stored(1), stored(2), stored(3), stored(4)],
    };
    const queued: Message = {
      id: 40, role: "user", content: "Fix these headings", created_at: "2026-10-12T05:00:00Z", attachments: [],
      metadata: { status: "queued", artifact_feedback: [stored(1), stored(2), stored(3), stored(4)] },
    };
    await mount("chat-c1", [queued]);
    publishOnServer(11, 1);
    await user.click(await screen.findByRole("button", { name: "Open Launch deck v1 · h1 · Heading 1" }));
    const panel = await artifactsPanel();
    await waitFor(() => expect(frame()).toHaveAttribute("src", "/artifact-view/t1-11-1/deck.html"));
    fireEvent.load(frame());
    await user.click(within(panel).getByRole("button", { name: "Annotate" }));
    // Two contexts already wait; three of the four withdrawn ones fit.
    fromPage(REGION);
    fromPage(REGION);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Remove Screenshot · Launch deck v1 · Region" })).toHaveLength(2));

    await user.click(screen.getByRole("button", { name: "Withdraw" }));
    expect(await screen.findByRole("button", { name: "Remove Launch deck v1 · h1 · Heading 1" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove Launch deck v1 · h3 · Heading 3" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Remove Launch deck v1 · h4 · Heading 4" })).not.toBeInTheDocument();
    expect(screen.getByText("1 feedback note was not restored: at most 5 can wait in the composer")).toBeVisible();
    // The screenshot returns with the message's files; the text returns too.
    expect(screen.getByRole("button", { name: "Remove capture-77.png" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Message" })).toHaveValue("Fix these headings");

    await user.click(screen.getByRole("button", { name: "Send" }));
    const [sent] = calls("POST", "/api/chat/conversations/c1/messages") as { attachment_ids: number[]; artifact_feedback: unknown[] }[];
    expect(sent.attachment_ids).toEqual([77, 901, 902]);
    expect(sent.artifact_feedback).toEqual([
      REGION_FEEDBACK, REGION_FEEDBACK,
      ...[1, 2, 3].map((n) => ({ artifact_id: 11, version: 1, path: "deck.html", kind: "element", selector: `main > h${n}`, text: `Heading ${n}`, rect: { x: n, y: 10, w: 100, h: 20 } })),
    ]);
  });

  it("shows a live card's state after a reload from the artifact list", async () => {
    store[LIVE.id] = { view: { ...LIVE, preview: preview("stopped") }, versions: [], preview: preview("stopped") };
    await mount("private", [{
      id: 30, role: "assistant", content: "The shop is running.", created_at: "2026-10-12T05:00:00Z", attachments: [],
      metadata: { status: "completed", artifacts: [{ id: 21, version: 0, title: "Shop preview", kind: "live", path: "live:web" }] },
    }]);
    // The panel is closed; the card still knows the state.
    expect(screen.queryByRole("complementary", { name: "Artifacts" })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Open Shop preview, Live preview · Stopped" })).toBeVisible();
    // The service starts again: the card follows the stream.
    previewState("running", "bg-5");
    expect(await screen.findByRole("button", { name: "Open Shop preview, Live preview · Running" })).toBeVisible();
  });
});
