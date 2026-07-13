// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { toast, ToastProvider, ToastViewport } from "./ToastContext";

function renderToasts() {
  const stack = document.createElement("div");
  stack.id = "toast-stack";
  document.body.appendChild(stack);
  render(
    <I18nProvider>
      <ToastProvider>
        <ToastViewport />
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

    expect(screen.getByText("failure").closest(".toast")).toHaveAttribute("role", "alert");
    expect(screen.getByText("saved").closest(".toast")).toHaveAttribute("role", "status");
  });

  it("pauses auto-dismiss while the notification is hovered", () => {
    act(() => toast("keep me", { type: "error" }));
    const node = screen.getByText("keep me").closest(".toast") as HTMLElement;

    fireEvent.mouseEnter(node);
    act(() => vi.advanceTimersByTime(7_000));
    expect(node).not.toHaveClass("is-leaving");

    fireEvent.mouseLeave(node);
    act(() => vi.advanceTimersByTime(6_500));
    expect(node).toHaveClass("is-leaving");
  });
});
