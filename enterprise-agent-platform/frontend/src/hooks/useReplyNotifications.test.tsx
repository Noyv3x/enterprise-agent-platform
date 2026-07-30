// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../i18n";
import { setBrowserNotificationsEnabled } from "../lib/browserNotifications";
import { createStore, type Store } from "../lib/store";
import { initialAppState, rootReducer } from "../store/reducer";
import { StoreContext } from "../store/StoreProvider";
import type { Action, AppState, User } from "../types";
import { useReplyNotifications } from "./useReplyNotifications";

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static instances: FakeNotification[] = [];
  static requestPermission = vi.fn(async () => FakeNotification.permission);
  onclick: (() => void) | null = null;
  close = vi.fn();

  constructor(readonly title: string, readonly options?: NotificationOptions) {
    FakeNotification.instances.push(this);
  }
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readonly withCredentials: boolean;
  readyState = 1;
  close = vi.fn(() => { this.readyState = 2; });
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(url: string | URL, init?: EventSourceInit) {
    this.url = String(url);
    this.withCredentials = Boolean(init?.withCredentials);
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback = typeof listener === "function" ? listener : listener.handleEvent.bind(listener);
    const listeners = this.listeners.get(type) || new Set<EventListener>();
    listeners.add(callback);
    this.listeners.set(type, listeners);
  }

  emit(type: "baseline" | "reply", payload: object, id: number): void {
    const event = new MessageEvent(type, {
      data: JSON.stringify(payload),
      lastEventId: String(id),
    });
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

function wrapperFor(store: Store<AppState, Action>) {
  return ({ children }: { children: ReactNode }) => (
    <I18nProvider>
      <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
    </I18nProvider>
  );
}

function enableFor(user: User): void {
  setBrowserNotificationsEnabled(user.id, true);
}

describe("useReplyNotifications", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    vi.spyOn(window, "focus").mockImplementation(() => undefined);
    FakeNotification.instances = [];
    FakeNotification.permission = "granted";
    FakeEventSource.instances = [];
    vi.stubGlobal("Notification", FakeNotification);
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("notifies for an inactive channel and navigates there when clicked", async () => {
    const user = { id: 7, username: "alice", permissions: ["private_agent"] } as User;
    const store = createStore(rootReducer, {
      ...initialAppState,
      user,
      activeView: "channel",
      activeChannelId: 1,
    });
    enableFor(user);
    renderHook(() => useReplyNotifications(), { wrapper: wrapperFor(store) });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const stream = FakeEventSource.instances[0];
    expect(stream.url).toBe("/api/agent/reply-events");
    expect(stream.withCredentials).toBe(true);

    act(() => {
      stream.emit("baseline", { watermark: 10 }, 10);
      stream.emit("reply", { message_id: 11, scope_type: "channel", scope_id: "2" }, 11);
      stream.emit("reply", { message_id: 11, scope_type: "channel", scope_id: "2" }, 11);
    });
    expect(FakeNotification.instances).toHaveLength(1);

    act(() => FakeNotification.instances[0].onclick?.());
    expect(store.getState().activeView).toBe("channel");
    expect(String(store.getState().activeChannelId)).toBe("2");
    expect(FakeNotification.instances[0].close).toHaveBeenCalledOnce();
  });

  it("notifies for a private reply while a channel is visible", async () => {
    const user = { id: 7, username: "alice", permissions: ["private_agent"] } as User;
    const store = createStore(rootReducer, {
      ...initialAppState,
      user,
      activeView: "channel",
      activeChannelId: 1,
    });
    enableFor(user);
    renderHook(() => useReplyNotifications(), { wrapper: wrapperFor(store) });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => {
      FakeEventSource.instances[0].emit("baseline", { watermark: 20 }, 20);
      FakeEventSource.instances[0].emit(
        "reply",
        { message_id: 21, scope_type: "private", scope_id: "7" },
        21,
      );
    });
    expect(FakeNotification.instances).toHaveLength(1);
    act(() => FakeNotification.instances[0].onclick?.());
    expect(store.getState().activeView).toBe("private");
  });

  it("suppresses baseline, replayed events, and replies while the page is visible", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    vi.mocked(document.hasFocus).mockReturnValue(true);
    const user = { id: 7, username: "alice", permissions: ["private_agent"] } as User;
    const store = createStore(rootReducer, { ...initialAppState, user, activeView: "private" });
    enableFor(user);
    renderHook(() => useReplyNotifications(), { wrapper: wrapperFor(store) });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => {
      FakeEventSource.instances[0].emit("baseline", { watermark: 30 }, 30);
      FakeEventSource.instances[0].emit(
        "reply",
        { message_id: 31, scope_type: "private", scope_id: "7" },
        31,
      );
    });
    expect(FakeNotification.instances).toHaveLength(0);

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    vi.mocked(document.hasFocus).mockReturnValue(false);
    act(() => {
      FakeEventSource.instances[0].emit(
        "reply",
        { message_id: 31, scope_type: "private", scope_id: "7" },
        31,
      );
    });
    expect(FakeNotification.instances).toHaveLength(0);
  });
});
