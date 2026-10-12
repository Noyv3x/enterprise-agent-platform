// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactVersion, ArtifactView } from "../../api";
import { ShellContext } from "../../components/ui/beautiful/controls";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { Conversation } from "../Conversation";
import { visibleContent } from "../conversation/Messages";
import type { Message } from "../conversation/types";
import { VIEW_REFRESH_LEAD_MS } from "./useViewUrl";

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
    const frames: FrameRequestCallback[] = [];
    const frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => -frames.push(callback));
    FakeEventSource.instances[FakeEventSource.instances.length - 1].dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify({ seq: ++seq, ...event }), lastEventId: String(seq) }));
    frame.mockRestore();
    for (const callback of frames) callback(performance.now());
  });
}

/** The server's artifacts: each with its versions, oldest first. */
let store: Record<number, { view: ArtifactView; versions: ArtifactVersion[] }> = {};
let minted: string[] = [];
let lifetimeMs = 2 * 60 * 60 * 1000;

function stamp(version: number) {
  return `2026-10-12T0${version}:00:00Z`;
}

/** Records version `version` of artifact `id` on the server and returns its view. */
function publishOnServer(id: number, version: number, title = "Launch deck", kind: ArtifactView["kind"] = "web"): ArtifactView {
  const existing = store[id];
  const view: ArtifactView = {
    id, scope: "chat-c1", path: `/workspace/c1/${kind === "site" ? "site" : "deck.html"}`, kind, title, entry: kind === "site" ? "index.html" : "deck.html",
    latest_version: version, created_at: stamp(1), updated_at: stamp(version),
  };
  const versions = [...(existing?.versions ?? [])];
  for (let next = (versions[versions.length - 1]?.version ?? 0) + 1; next <= version; next++) {
    versions.push({ version: next, entry: view.entry ?? "", created_at: stamp(next), total_size: 1000, file_count: 1, message_id: null });
  }
  store[id] = { view, versions };
  return view;
}

/** A live publish: the server records it and the stream announces it. */
function publish(id: number, version: number, title?: string) {
  const artifact = publishOnServer(id, version, title);
  emit({ type: "artifact", artifact, version });
}

function reply(id: number, artifacts: { id: number; version: number }[] = []): Message {
  return {
    id, role: "assistant", content: `Here is the deck.\nMEDIA: /workspace/c1/deck.html`,
    metadata: { status: "completed", artifacts: artifacts.map((item) => ({ ...item, title: store[item.id]?.view.title ?? "Launch deck", kind: "web", path: "/workspace/c1/deck.html" })) },
    created_at: "2026-10-12T05:00:00Z", attachments: [],
  };
}

function route(path: string, method: string, messages: Message[]): unknown {
  if (/^\/api\/(chat\/)?conversations\/[^/]+\/messages/.test(path)) return { messages, next_before_id: null, last_seq: 0, compaction: null };
  if (path.startsWith("/api/artifacts?scope=")) return { artifacts: Object.values(store).map((item) => item.view).reverse() };
  let match = /^\/api\/artifacts\/(\d+)$/.exec(path);
  if (match) {
    const item = store[Number(match[1])];
    if (!item) throw new Error("not found");
    return { artifact: item.view, versions: [...item.versions].reverse() };
  }
  match = /^\/api\/artifacts\/(\d+)\/versions\/(\d+)\/view$/.exec(path);
  if (match && method === "POST") {
    const url = `/artifact-view/t${minted.length + 1}-${match[1]}-${match[2]}/deck.html`;
    minted.push(url);
    return { url, expires_at: new Date(Date.now() + lifetimeMs).toISOString() };
  }
  if (path === "/api/tasks") return { tasks: [] };
  if (path === "/api/browser") return { tabs: [], lease: null };
  if (path.startsWith("/api/workspace/files")) return { files: [] };
  throw new Error(`unexpected ${method} ${path}`);
}

async function mount(scope: string, messages: Message[] = [], narrow = false) {
  api.request.mockImplementation(async (path: string, options: RequestInit = {}) => route(path, options.method ?? "GET", messages));
  const aside = document.createElement("div");
  document.body.append(aside);
  const view = render(
    <I18nProvider>
      <ShellContext.Provider value={{ narrow, openNavigation: () => undefined, asideSlot: narrow ? null : aside }}>
        <Conversation scope={scope} />
      </ShellContext.Provider>
    </I18nProvider>,
  );
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  await screen.findByRole("log", { name: "Conversation" }).catch(() => undefined);
  return view;
}

const frame = () => document.querySelector("iframe");
const artifactsPanel = () => screen.findByRole("complementary", { name: "Artifacts" });
const versionSelect = (panel: HTMLElement) => within(panel).getByRole("combobox", { name: "Version" });

async function chooseVersion(panel: HTMLElement, version: number) {
  const user = userEvent.setup();
  await user.click(versionSelect(panel));
  await user.click(await screen.findByRole("option", { name: new RegExp(`^v${version} ·`) }));
}

describe("Artifacts", () => {
  beforeEach(() => {
    seq = 0;
    store = {};
    minted = [];
    lifetimeMs = 2 * 60 * 60 * 1000;
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("shows a live card from SSE, opens the channel's panel on it, and keeps the card from metadata after a reload", async () => {
    await mount("channel-7");
    emit({ type: "text_delta", delta: "Building the deck" });
    publish(11, 1);
    const live = screen.getByRole("article", { name: "Reply in progress" });
    expect(within(live).getByRole("button", { name: "Open Launch deck, v1 · Web page" })).toBeVisible();

    // Desktop: the first publish of an artifact opens the panel at it.
    const panel = await artifactsPanel();
    await waitFor(() => expect(frame()).toHaveAttribute("src", "/artifact-view/t1-11-1/deck.html"));
    expect(frame()).toHaveAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads");
    expect(within(panel).getByRole("heading", { name: "Launch deck" })).toBeVisible();
    expect(within(panel).queryByRole("tab", { name: "Computer" })).not.toBeInTheDocument();

    emit({ type: "run_end", message: reply(5, [{ id: 11, version: 1 }]) });
    const settled = screen.getByRole("article", { name: "Agent reply" });
    expect(within(settled).getByRole("button", { name: "Open Launch deck, v1 · Web page" })).toBeVisible();
    // The card replaces the MEDIA line it published.
    expect(within(settled).queryByText(/MEDIA:/)).not.toBeInTheDocument();

    cleanup();
    document.body.innerHTML = "";
    FakeEventSource.instances = [];
    await mount("channel-7", [reply(5, [{ id: 11, version: 1 }])]);
    const restored = await screen.findByRole("article", { name: "Agent reply" });
    expect(within(restored).getByRole("button", { name: "Open Launch deck, v1 · Web page" })).toBeVisible();
    // A reload does not reopen the panel by itself.
    expect(screen.queryByRole("complementary", { name: "Artifacts" })).not.toBeInTheDocument();
  });

  it("opens a card at the version its message created, and switches versions", async () => {
    const user = userEvent.setup();
    publishOnServer(11, 3);
    await mount("chat-c1", [reply(5, [{ id: 11, version: 2 }])]);
    await user.click(await screen.findByRole("button", { name: "Open Launch deck, v2 · Web page" }));

    const panel = await artifactsPanel();
    await waitFor(() => expect(frame()).toHaveAttribute("src", "/artifact-view/t1-11-2/deck.html"));
    expect(versionSelect(panel)).toHaveTextContent(/^v2 ·/);
    expect(within(panel).getByRole("link", { name: "Download v2" })).toHaveAttribute("href", "/api/artifacts/11/versions/2/download");
    expect(within(panel).getByRole("link", { name: "Open in new tab" })).toHaveAttribute("href", "/artifact-view/t1-11-2/deck.html");
    expect(screen.getByRole("button", { name: "Open Launch deck, v2 · Web page" })).toHaveAttribute("aria-current", "true");

    await user.click(versionSelect(panel));
    expect(screen.getByRole("option", { name: /^v3 · .* · Latest$/ })).toBeVisible();
    await user.click(screen.getByRole("option", { name: /^v3 ·/ }));
    await waitFor(() => expect(frame()).toHaveAttribute("src", "/artifact-view/t2-11-3/deck.html"));
    expect(within(panel).getByRole("link", { name: "Download v3" })).toBeVisible();
  });

  it("follows new versions while the latest is open, and offers the newer one on an older version", async () => {
    const user = userEvent.setup();
    await mount("chat-c1");
    emit({ type: "text_delta", delta: "Drafting" });
    publish(11, 1);
    publish(11, 2);
    const panel = await artifactsPanel();
    await waitFor(() => expect(versionSelect(panel)).toHaveTextContent(/^v2 ·/));
    expect(within(panel).getByRole("status", { name: "Version updates" })).toHaveTextContent("Updated to v2");
    await waitFor(() => expect(frame()).toHaveAttribute("src", expect.stringMatching(/-11-2\/deck\.html$/)));
    // The live card follows too: one card per artifact, at its newest version.
    expect(within(screen.getByRole("article", { name: "Reply in progress" })).getByRole("button", { name: "Open Launch deck, v2 · Web page" })).toBeVisible();

    await chooseVersion(panel, 1);
    await waitFor(() => expect(frame()).toHaveAttribute("src", expect.stringMatching(/-11-1\/deck\.html$/)));
    publish(11, 3);
    await waitFor(() => expect(within(panel).getByRole("status", { name: "Version updates" })).toHaveTextContent("A newer version v3 is available"));
    expect(versionSelect(panel)).toHaveTextContent(/^v1 ·/);
    await user.click(within(panel).getByRole("button", { name: "View" }));
    await waitFor(() => expect(versionSelect(panel)).toHaveTextContent(/^v3 ·/));
    expect(within(panel).queryByText(/newer version/)).not.toBeInTheDocument();
    await waitFor(() => expect(frame()).toHaveAttribute("src", expect.stringMatching(/-11-3\/deck\.html$/)));

    // Back on the latest, the next version is followed again.
    publish(11, 4);
    await waitFor(() => expect(versionSelect(panel)).toHaveTextContent(/^v4 ·/));
  });

  it("previews web pages at desktop, tablet and phone widths", async () => {
    const user = userEvent.setup();
    await mount("chat-c1");
    emit({ type: "text_delta", delta: "Drafting" });
    publish(11, 1);
    const panel = await artifactsPanel();
    await waitFor(() => expect(frame()).not.toBeNull());
    expect(within(panel).getByRole("tab", { name: "Desktop" })).toHaveAttribute("aria-selected", "true");
    expect(frame()).toHaveStyle({ width: "100%" });
    await user.click(within(panel).getByRole("tab", { name: "Phone" }));
    expect(frame()).toHaveStyle({ width: "390px" });
    await user.click(within(panel).getByRole("tab", { name: "Tablet" }));
    expect(frame()).toHaveStyle({ width: "768px" });
    // The width belongs to the preview; the source view has none.
    await user.click(within(panel).getByRole("tab", { name: "Source" }));
    expect(within(panel).queryByRole("tab", { name: "Tablet" })).not.toBeInTheDocument();
  });

  it("re-mints the view URL before its token expires", async () => {
    lifetimeMs = VIEW_REFRESH_LEAD_MS + 1200;
    await mount("chat-c1");
    emit({ type: "text_delta", delta: "Drafting" });
    publish(11, 1);
    const panel = await artifactsPanel();
    await waitFor(() => expect(frame()).toHaveAttribute("src", "/artifact-view/t1-11-1/deck.html"));
    await waitFor(() => expect(frame()).toHaveAttribute("src", "/artifact-view/t2-11-1/deck.html"), { timeout: 4000 });
    expect(within(panel).getByRole("link", { name: "Open in new tab" })).toHaveAttribute("href", "/artifact-view/t2-11-1/deck.html");
  });

  it("shares the personal aside between Artifacts and Computer", async () => {
    const user = userEvent.setup();
    await mount("private");
    const computer = await screen.findByRole("complementary", { name: "Computer" });
    expect(within(computer).getByRole("tab", { name: "Computer" })).toHaveAttribute("aria-selected", "true");
    await user.click(within(computer).getByRole("tab", { name: "Artifacts" }));

    const panel = await artifactsPanel();
    expect(await within(panel).findByText("No artifacts yet")).toBeVisible();
    expect(screen.getByRole("button", { name: "Artifacts" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Computer" })).toHaveAttribute("aria-pressed", "false");

    await user.click(within(panel).getByRole("tab", { name: "Computer" }));
    expect(await screen.findByRole("region", { name: "Computer screen" })).toBeVisible();
    expect(screen.queryByRole("complementary", { name: "Artifacts" })).not.toBeInTheDocument();

    // A publish takes the shared window from the computer.
    emit({ type: "text_delta", delta: "Drafting" });
    publish(11, 1);
    await artifactsPanel();
  });

  it("gives chat the panel with the conversation's artifacts", async () => {
    const user = userEvent.setup();
    publishOnServer(11, 2);
    publishOnServer(12, 1, "Quarterly report");
    await mount("chat-c1");
    expect(screen.queryByRole("button", { name: "Computer" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Artifacts" }));
    const panel = await artifactsPanel();
    const list = await within(panel).findByRole("list", { name: "Artifacts in this conversation" });
    expect(within(list).getAllByRole("button").map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^Launch deckv2 · Web page · /),
      expect.stringMatching(/^Quarterly reportv1 · Web page · /),
    ]);
    await user.click(within(list).getByRole("button", { name: /^Launch deck/ }));
    await waitFor(() => expect(versionSelect(panel)).toHaveTextContent(/^v2 ·/));
    await user.click(within(panel).getByRole("button", { name: "All artifacts" }));
    expect(within(panel).getByRole("list", { name: "Artifacts in this conversation" })).toBeVisible();
    await user.click(within(panel).getByRole("button", { name: "Close artifacts" }));
    expect(screen.queryByRole("complementary", { name: "Artifacts" })).not.toBeInTheDocument();
  });

  it("opens in a full-screen sheet on mobile, only when asked", async () => {
    const user = userEvent.setup();
    await mount("chat-c1", [], true);
    emit({ type: "text_delta", delta: "Drafting" });
    publish(11, 1);
    // No sheet takes over the phone by itself.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open Launch deck, v1 · Web page" }));
    const sheet = await screen.findByRole("dialog", { name: "Artifacts" });
    await waitFor(() => expect(within(sheet).getByRole("heading", { name: "Launch deck" })).toBeVisible());
    await waitFor(() => expect(frame()).toHaveAttribute("src", "/artifact-view/t1-11-1/deck.html"));
    await user.click(within(sheet).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("visibleContent", () => {
  it("hides the MEDIA lines of files the message published as artifacts, by sandbox path or basename", () => {
    const message: Message = {
      id: 9, role: "assistant", created_at: "2026-10-12T05:00:00Z", attachments: [],
      content: "Done.\nMEDIA: /workspace/c1/out/deck.html\nMEDIA: notes.md\nMEDIA: /workspace/c1/report.docx",
      metadata: { status: "completed", artifacts: [
        { id: 1, version: 2, title: "Deck", kind: "web", path: "/workspace/c1/out/deck.html" },
        { id: 2, version: 1, title: "Notes", kind: "markdown", path: "/workspace/c1/notes.md" },
      ] },
    };
    // A downloadable file that did not become an artifact or attachment keeps its line.
    expect(visibleContent(message)).toBe("Done.\nMEDIA: /workspace/c1/report.docx");
  });
});
