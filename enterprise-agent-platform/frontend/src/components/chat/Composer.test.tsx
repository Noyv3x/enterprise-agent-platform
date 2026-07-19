// @vitest-environment jsdom

import { useLayoutEffect, useState } from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToastProvider } from "../../context/ToastContext";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { StoreProvider } from "../../store/StoreProvider";
import { useStoreHandle } from "../../store/useStore";
import type { ChatMode, FailedSend } from "../../types";
import { Composer } from "./Composer";

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
  });

  afterEach(cleanup);

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
