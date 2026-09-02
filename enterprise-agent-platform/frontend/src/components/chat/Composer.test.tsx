// @vitest-environment jsdom

import { useLayoutEffect, useState } from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../context/ToastContext";
import { resetSession } from "../../data/sessionActions";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { BROWSER_CONTROL_RELINQUISH_EVENT } from "../../lib/browserControl";
import { ApiError } from "../../lib/api";
import { StoreProvider } from "../../store/StoreProvider";
import { useStoreHandle } from "../../store/useStore";
import type { AppStore } from "../../data/loaders";
import type { ChatMode, FailedSend } from "../../types";
import { Composer } from "./Composer";

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn().mockResolvedValue(true),
  compactAgentSession: vi.fn().mockResolvedValue({
    compacted: true,
    omitted_messages: 9,
    retained_messages: 7,
  }),
}));

vi.mock("../../data/chatActions", () => ({
  sendMessage: mocks.sendMessage,
  compactAgentSession: mocks.compactAgentSession,
}));

function ComposerHarness({
  mode,
  scopeId,
  failedSend,
  onStore,
}: {
  mode: ChatMode;
  scopeId: string;
  failedSend?: FailedSend;
  onStore?: (store: AppStore) => void;
}) {
  const store = useStoreHandle();
  const draftKey = `${mode}:${scopeId}`;
  const [seeded, setSeeded] = useState(!failedSend);

  useLayoutEffect(() => {
    onStore?.(store);
    if (!failedSend) return;
    store.dispatch({
      type: "ADD_FAILED_SEND",
      payload: { key: draftKey, send: failedSend },
    });
    setSeeded(true);
  }, [draftKey, failedSend, onStore, store]);

  if (!seeded) return null;
  return (
    <Composer
      mode={mode}
      scopeId={scopeId}
      draftKey={draftKey}
      disabled={false}
      placeholder={`${mode} placeholder`}
      focusToken={0}
      onBumpFocus={() => undefined}
      onBumpForceBottom={() => undefined}
    />
  );
}

function composerTree(
  mode: ChatMode,
  scopeId: string,
  failedSend?: FailedSend,
  onStore?: (store: AppStore) => void,
) {
  return (
    <I18nProvider>
      <ToastProvider>
        <StoreProvider>
          <ComposerHarness mode={mode} scopeId={scopeId} failedSend={failedSend} onStore={onStore} />
        </StoreProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

function renderComposer(
  mode: ChatMode,
  scopeId: string,
  failedSend?: FailedSend,
  onStore?: (store: AppStore) => void,
) {
  return render(composerTree(mode, scopeId, failedSend, onStore));
}

describe("Composer store subscriptions", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    mocks.sendMessage.mockClear();
    mocks.compactAgentSession.mockReset().mockResolvedValue({
      compacted: true,
      omitted_messages: 9,
      retained_messages: 7,
    });
  });

  afterEach(cleanup);

  it("waits for same-scope browser control to be relinquished before sending", async () => {
    let finishRelinquish!: () => void;
    const pendingRelinquish = new Promise<void>((resolve) => {
      finishRelinquish = resolve;
    });
    const relinquished = vi.fn((event: Event) => {
      const detail = (event as CustomEvent<{ waitUntil: (operation: Promise<unknown>) => void }>).detail;
      detail.waitUntil(pendingRelinquish);
    });
    window.addEventListener(BROWSER_CONTROL_RELINQUISH_EVENT, relinquished);
    try {
      renderComposer("private", "7");
      fireEvent.change(screen.getByLabelText("Message input"), {
        target: { value: "try the browser again" },
      });
      fireEvent.submit(screen.getByRole("button", { name: "Send" }).closest("form")!);

      expect(relinquished).toHaveBeenCalledTimes(1);
      expect((relinquished.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
        scope_type: "private",
        scope_id: "7",
      });
      expect(mocks.sendMessage).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Message input")).toHaveValue("");
      fireEvent.submit(screen.getByRole("button", { name: "Send" }).closest("form")!);
      expect(relinquished).toHaveBeenCalledTimes(1);
      finishRelinquish();
      await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1));
    } finally {
      window.removeEventListener(BROWSER_CONTROL_RELINQUISH_EVENT, relinquished);
    }
  });

  it("drops an outgoing account payload when a deferred channel send crosses logout and login", async () => {
    let finishRelinquish!: () => void;
    const pendingRelinquish = new Promise<void>((resolve) => {
      finishRelinquish = resolve;
    });
    const relinquished = (event: Event) => {
      const detail = (event as CustomEvent<{ waitUntil: (operation: Promise<unknown>) => void }>).detail;
      detail.waitUntil(pendingRelinquish);
    };
    let store!: AppStore;
    const exposeStore = (nextStore: AppStore) => {
      store = nextStore;
    };
    window.addEventListener(BROWSER_CONTROL_RELINQUISH_EVENT, relinquished);
    try {
      renderComposer("channel", "12", undefined, exposeStore);
      act(() => {
        store.dispatch({ type: "SET_USER", payload: { id: 7, username: "alice" } });
        store.dispatch({ type: "SET_ACTIVE_VIEW", payload: "channel" });
        store.dispatch({ type: "SET_ACTIVE_CHANNEL_ID", payload: 12 });
      });

      const input = screen.getByLabelText("Message input");
      const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;
      const attachment = new File(["handoff"], "handoff.txt", { type: "text/plain" });
      fireEvent.change(input, { target: { value: "original account draft" } });
      fireEvent.change(fileInput, { target: { files: [attachment] } });
      fireEvent.submit(screen.getByRole("button", { name: "Send" }).closest("form")!);
      expect(input).toHaveValue("");

      act(() => {
        resetSession(store);
        store.dispatch({ type: "SET_USER", payload: { id: 8, username: "bob" } });
        store.dispatch({ type: "SET_ACTIVE_VIEW", payload: "channel" });
        store.dispatch({ type: "SET_ACTIVE_CHANNEL_ID", payload: 12 });
      });
      fireEvent.change(input, { target: { value: "newer draft" } });

      await act(async () => finishRelinquish());

      expect(mocks.sendMessage).not.toHaveBeenCalled();
      expect(input).toHaveValue("newer draft");
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.queryByText("original account draft")).not.toBeInTheDocument();
      expect(screen.queryByText("handoff.txt")).not.toBeInTheDocument();
    } finally {
      window.removeEventListener(BROWSER_CONTROL_RELINQUISH_EVENT, relinquished);
    }
  });

  it("recovers a deferred payload only to its original scope after the Composer unmounts", async () => {
    let finishRelinquish!: () => void;
    const pendingRelinquish = new Promise<void>((resolve) => {
      finishRelinquish = resolve;
    });
    const relinquished = (event: Event) => {
      const detail = (event as CustomEvent<{ waitUntil: (operation: Promise<unknown>) => void }>).detail;
      detail.waitUntil(pendingRelinquish);
    };
    let store!: AppStore;
    const exposeStore = (nextStore: AppStore) => {
      store = nextStore;
    };
    window.addEventListener(BROWSER_CONTROL_RELINQUISH_EVENT, relinquished);
    try {
      const view = renderComposer("channel", "12", undefined, exposeStore);
      act(() => {
        store.dispatch({ type: "SET_USER", payload: { id: 7, username: "alice" } });
        store.dispatch({ type: "SET_ACTIVE_VIEW", payload: "channel" });
        store.dispatch({ type: "SET_ACTIVE_CHANNEL_ID", payload: 12 });
      });

      const input = screen.getByLabelText("Message input");
      const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;
      const attachment = new File(["scope"], "original-scope.txt", { type: "text/plain" });
      fireEvent.change(input, { target: { value: "return this to channel twelve" } });
      fireEvent.change(fileInput, { target: { files: [attachment] } });
      fireEvent.submit(screen.getByRole("button", { name: "Send" }).closest("form")!);

      view.unmount();
      act(() => {
        store.dispatch({ type: "SET_ACTIVE_CHANNEL_ID", payload: 13 });
      });
      await act(async () => finishRelinquish());

      expect(mocks.sendMessage).not.toHaveBeenCalled();
      expect(store.getState().drafts["channel:12"]).toBe("return this to channel twelve");
      expect(store.getState().draftFiles["channel:12"]).toEqual([attachment]);
      expect(store.getState().drafts["channel:13"]).toBeUndefined();
      expect(store.getState().draftFiles["channel:13"]).toBeUndefined();
    } finally {
      window.removeEventListener(BROWSER_CONTROL_RELINQUISH_EVENT, relinquished);
    }
  });

  it("captures a later draft while an earlier browser handoff is pending", async () => {
    let finishRelinquish!: () => void;
    const pendingRelinquish = new Promise<void>((resolve) => {
      finishRelinquish = resolve;
    });
    const relinquished = (event: Event) => {
      const detail = (event as CustomEvent<{ waitUntil: (operation: Promise<unknown>) => void }>).detail;
      detail.waitUntil(pendingRelinquish);
    };
    window.addEventListener(BROWSER_CONTROL_RELINQUISH_EVENT, relinquished);
    try {
      renderComposer("private", "7");
      const input = screen.getByLabelText("Message input");
      const form = screen.getByRole("button", { name: "Send" }).closest("form")!;
      fireEvent.change(input, { target: { value: "first" } });
      fireEvent.submit(form);
      fireEvent.change(input, { target: { value: "second" } });
      fireEvent.submit(form);

      expect(input).toHaveValue("");
      expect(mocks.sendMessage).not.toHaveBeenCalled();
      finishRelinquish();
      await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(2));
      expect(mocks.sendMessage.mock.calls.map((call) => call[3])).toEqual(["first", "second"]);
    } finally {
      window.removeEventListener(BROWSER_CONTROL_RELINQUISH_EVENT, relinquished);
    }
  });

  it.each([
    ["private", "7"],
    ["channel", "12"],
  ] as const)(
    "renders the %s composer with the real StoreProvider and an empty failed-send queue",
    (mode, scopeId) => {
      renderComposer(mode, scopeId);

      expect(screen.getByLabelText("Message input")).toHaveAttribute(
        "placeholder",
        `${mode} placeholder`,
      );
      expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute("type", "submit");
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    },
  );

  it.each([
    ["private", "7"],
    ["channel", "12"],
  ] as const)("discovers and executes /compact locally in the %s composer", async (mode, scopeId) => {
    const relinquished = vi.fn();
    window.addEventListener(BROWSER_CONTROL_RELINQUISH_EVENT, relinquished);
    try {
      renderComposer(mode, scopeId);
      const input = screen.getByLabelText("Message input");
      input.focus();
      fireEvent.change(input, { target: { value: "/" } });
      const option = screen.getByRole("option", { name: /compact/i });
      expect(option).toHaveAttribute("tabindex", "-1");
      fireEvent.mouseDown(option);
      fireEvent.click(option);
      expect(input).toHaveValue("/compact");
      expect(input).toHaveFocus();
      fireEvent.submit(screen.getByRole("button", { name: "Send" }).closest("form")!);

      await waitFor(() => expect(mocks.compactAgentSession).toHaveBeenCalledWith(mode, scopeId));
      expect(mocks.compactAgentSession).toHaveBeenCalledTimes(1);
      expect(mocks.sendMessage).not.toHaveBeenCalled();
      expect(relinquished).not.toHaveBeenCalled();
      expect(input).toHaveValue("");
      const success = await screen.findByRole("status");
      expect(success).toHaveTextContent("Archived: 9; retained in active context: 7.");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally {
      window.removeEventListener(BROWSER_CONTROL_RELINQUISH_EVENT, relinquished);
    }
  });

  it("completes /compact from the textarea with Tab and executes it with Enter", async () => {
    renderComposer("private", "7");
    const input = screen.getByLabelText("Message input");
    input.focus();
    fireEvent.change(input, { target: { value: "/c" } });

    fireEvent.keyDown(input, { key: "Tab" });
    expect(input).toHaveValue("/compact");
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(mocks.compactAgentSession).toHaveBeenCalledWith("private", "7"));
  });

  it("dismisses the slash menu with Escape and reopens it after the draft changes", () => {
    renderComposer("private", "7");
    const input = screen.getByLabelText("Message input");
    input.focus();
    fireEvent.change(input, { target: { value: "/" } });
    expect(screen.getByRole("option", { name: /compact/i })).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("option", { name: /compact/i })).not.toBeInTheDocument();
    expect(input).toHaveValue("/");
    expect(input).toHaveFocus();

    fireEvent.change(input, { target: { value: "/c" } });
    expect(screen.getByRole("option", { name: /compact/i })).toBeInTheDocument();
  });

  it("does not expose or execute the slash command during IME composition", () => {
    renderComposer("private", "7");
    const input = screen.getByLabelText("Message input");
    const form = screen.getByRole("button", { name: "Send" }).closest("form")!;

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "/compact" } });
    expect(screen.queryByRole("option", { name: /compact/i })).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.submit(form);
    expect(mocks.compactAgentSession).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input);
    expect(screen.getByRole("option", { name: /compact/i })).toBeInTheDocument();
  });

  it("announces a no-op compaction as a polite success", async () => {
    mocks.compactAgentSession.mockResolvedValueOnce({
      compacted: false,
      omitted_messages: 0,
      retained_messages: 3,
    });
    renderComposer("private", "7");
    const input = screen.getByLabelText("Message input");
    fireEvent.change(input, { target: { value: "/compact" } });
    fireEvent.submit(screen.getByRole("button", { name: "Send" }).closest("form")!);

    expect(await screen.findByRole("status")).toHaveTextContent(
      "This session is already small, so nothing changed.",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps /compact in the draft when the session is busy", async () => {
    mocks.compactAgentSession.mockRejectedValueOnce(new ApiError("busy", 409));
    renderComposer("private", "7");
    const input = screen.getByLabelText("Message input");
    fireEvent.change(input, { target: { value: "/compact" } });
    fireEvent.submit(screen.getByRole("button", { name: "Send" }).closest("form")!);

    expect(await screen.findByText(/The Agent is working in this conversation/)).toBeInTheDocument();
    expect(input).toHaveValue("/compact");
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("localizes unexpected compaction failures without exposing backend details", async () => {
    mocks.compactAgentSession.mockRejectedValueOnce(new ApiError("sensitive backend diagnostic", 500));
    renderComposer("private", "7");
    const input = screen.getByLabelText("Message input");
    fireEvent.change(input, { target: { value: "/compact" } });
    fireEvent.submit(screen.getByRole("button", { name: "Send" }).closest("form")!);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The session could not be compacted. Try again shortly.",
    );
    expect(screen.queryByText("sensitive backend diagnostic")).not.toBeInTheDocument();
    expect(input).toHaveValue("/compact");
  });

  it("keeps the /compact draft and its attachment when rejecting the command", async () => {
    renderComposer("private", "7");
    const input = screen.getByLabelText("Message input");
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const attachment = new File(["sheet"], "budget.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    fireEvent.change(fileInput, { target: { files: [attachment] } });
    fireEvent.change(input, { target: { value: "/compact" } });
    fireEvent.submit(screen.getByRole("button", { name: "Send" }).closest("form")!);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "/compact cannot include attachments. Remove them first.",
    );
    expect(input).toHaveValue("/compact");
    expect(screen.getByText("budget.xlsx")).toBeInTheDocument();
    expect(mocks.compactAgentSession).not.toHaveBeenCalled();
  });

  it("disables the composer and coalesces duplicate submits while compacting", async () => {
    let finish!: (value: { compacted: boolean; omitted_messages: number; retained_messages: number }) => void;
    mocks.compactAgentSession.mockReturnValueOnce(new Promise((resolve) => {
      finish = resolve;
    }));
    renderComposer("private", "7");
    const input = screen.getByLabelText("Message input");
    const send = screen.getByRole("button", { name: "Send" });
    const form = send.closest("form")!;
    fireEvent.change(input, { target: { value: "/compact" } });
    fireEvent.submit(form);

    await waitFor(() => expect(form).toHaveAttribute("aria-busy", "true"));
    expect(input).toBeDisabled();
    expect(send).toBeDisabled();
    fireEvent.submit(form);
    expect(mocks.compactAgentSession).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).not.toHaveBeenCalled();

    await act(async () => finish({ compacted: true, omitted_messages: 2, retained_messages: 4 }));
    await waitFor(() => expect(form).toHaveAttribute("aria-busy", "false"));
    expect(input).not.toBeDisabled();
  });

  it("keeps a new scope busy when an older scope finishes out of order", async () => {
    type CompactResult = { compacted: boolean; omitted_messages: number; retained_messages: number };
    let finishFirst!: (value: CompactResult) => void;
    let finishSecond!: (value: CompactResult) => void;
    mocks.compactAgentSession
      .mockReturnValueOnce(new Promise((resolve) => { finishFirst = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { finishSecond = resolve; }));

    const view = renderComposer("private", "7");
    let input = screen.getByLabelText("Message input");
    fireEvent.change(input, { target: { value: "/compact" } });
    fireEvent.submit(screen.getByRole("button", { name: "Send" }).closest("form")!);
    await waitFor(() => expect(mocks.compactAgentSession).toHaveBeenCalledWith("private", "7"));

    view.rerender(composerTree("private", "8"));
    input = screen.getByLabelText("Message input");
    expect(input).not.toBeDisabled();
    fireEvent.change(input, { target: { value: "/compact" } });
    fireEvent.submit(screen.getByRole("button", { name: "Send" }).closest("form")!);
    await waitFor(() => expect(mocks.compactAgentSession).toHaveBeenCalledWith("private", "8"));
    expect(input).toBeDisabled();

    await act(async () => finishFirst({ compacted: true, omitted_messages: 11, retained_messages: 5 }));
    expect(input).toBeDisabled();
    expect(screen.queryByText("Archived: 11; retained in active context: 5.")).not.toBeInTheDocument();

    await act(async () => finishSecond({ compacted: true, omitted_messages: 3, retained_messages: 6 }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Archived: 3; retained in active context: 6.",
    );
    await waitFor(() => expect(input).not.toBeDisabled());
  });

  it("rejects /compact arguments locally but leaves unknown slash text as a message", async () => {
    renderComposer("private", "7");
    const input = screen.getByLabelText("Message input");
    const form = screen.getByRole("button", { name: "Send" }).closest("form")!;
    fireEvent.change(input, { target: { value: "/compact now" } });
    fireEvent.submit(form);
    expect(await screen.findByText("/compact does not support arguments yet.")).toBeInTheDocument();
    expect(input).toHaveValue("/compact now");
    expect(mocks.compactAgentSession).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "/unknown" } });
    fireEvent.submit(form);
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      "private",
      "7",
      "/unknown",
      [],
    ));
  });

  it.each([
    ["private", "7"],
    ["channel", "12"],
  ] as const)(
    "shows and restores a queued failed send in the %s composer through the real store",
    (mode, scopeId) => {
      renderComposer(mode, scopeId, {
        id: `failed-${mode}`,
        content: "Please retry this message",
        files: [],
      });

      expect(screen.getByRole("status")).toHaveTextContent("1 failed message is waiting");
      expect(screen.getByRole("status")).toHaveTextContent("Please retry this message");

      fireEvent.click(screen.getByRole("button", { name: "Restore" }));

      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Message input")).toHaveValue("Please retry this message");
    },
  );
});
