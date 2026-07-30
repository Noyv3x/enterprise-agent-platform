// @vitest-environment jsdom

import { useLayoutEffect, useState } from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../context/ToastContext";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { BROWSER_CONTROL_RELINQUISH_EVENT } from "../../lib/browserControl";
import { StoreProvider } from "../../store/StoreProvider";
import { useStoreHandle } from "../../store/useStore";
import type { ChatMode, FailedSend } from "../../types";
import { Composer } from "./Composer";

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../data/chatActions", () => ({ sendMessage: mocks.sendMessage }));

function ComposerHarness({
  mode,
  scopeId,
  failedSend,
}: {
  mode: ChatMode;
  scopeId: string;
  failedSend?: FailedSend;
}) {
  const store = useStoreHandle();
  const draftKey = `${mode}:${scopeId}`;
  const [seeded, setSeeded] = useState(!failedSend);

  useLayoutEffect(() => {
    if (!failedSend) return;
    store.dispatch({
      type: "ADD_FAILED_SEND",
      payload: { key: draftKey, send: failedSend },
    });
    setSeeded(true);
  }, [draftKey, failedSend, store]);

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

function renderComposer(mode: ChatMode, scopeId: string, failedSend?: FailedSend) {
  return render(
    <I18nProvider>
      <ToastProvider>
        <StoreProvider>
          <ComposerHarness mode={mode} scopeId={scopeId} failedSend={failedSend} />
        </StoreProvider>
      </ToastProvider>
    </I18nProvider>,
  );
}

describe("Composer store subscriptions", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    mocks.sendMessage.mockClear();
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
