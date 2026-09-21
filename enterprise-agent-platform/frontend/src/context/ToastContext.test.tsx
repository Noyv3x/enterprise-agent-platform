// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { toast, ToastProvider } from "./ToastContext";

function renderToasts() {
  render(
    <I18nProvider>
      <ToastProvider>
        <button type="button">Application</button>
      </ToastProvider>
    </I18nProvider>,
  );
}

describe("toast accessibility and timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    renderToasts();
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("announces failures assertively and success politely", () => {
    act(() => toast("failure", { type: "error" }));
    act(() => toast("saved", { type: "ok" }));

    expect(screen.getByRole("alert")).toHaveTextContent("failure");
    expect(screen.getByRole("status")).toHaveTextContent("saved");
  });

  it("pauses auto-dismiss while the notification is hovered", () => {
    act(() => toast("keep me", { type: "error" }));
    const node = screen.getByRole("alert");

    fireEvent.mouseEnter(node);
    act(() => vi.advanceTimersByTime(7_000));
    expect(screen.getByText("keep me")).toBeInTheDocument();

    fireEvent.mouseLeave(node);
    act(() => vi.runAllTimers());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps a notification available while its dismiss button has keyboard focus", () => {
    act(() => toast("keyboard notice", { type: "error" }));
    const dismiss = screen.getByRole("button", { name: "Dismiss notification" });
    act(() => dismiss.focus());
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole("alert")).toHaveTextContent("keyboard notice");

    act(() => screen.getByRole("button", { name: "Application" }).focus());
    act(() => vi.runAllTimers());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
