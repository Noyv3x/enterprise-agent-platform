// @vitest-environment jsdom

import { createRef, type RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../i18n";
import type { MentionApi } from "./useMention";
import { distanceFromBottom, isNearBottom, useStickyScroll } from "./useStickyScroll";
import { ComposerTextarea } from "../components/chat/ComposerTextarea";

function StickyHarness({
  scope = "channel:1",
  count = 1,
  force = 0,
  revision,
}: {
  scope?: string;
  count?: number;
  force?: number;
  revision?: number;
}) {
  const ref = createRef<HTMLDivElement>();
  const state = useStickyScroll(ref, scope, force, count, revision ?? count);
  return (
    <div>
      <div ref={ref} data-testid="scroller" />
      <output data-testid="position">{state.atBottom ? "bottom" : "away"}</output>
      <output data-testid="unread">{state.unreadCount}</output>
      <button type="button" onClick={state.scrollToBottom}>latest</button>
    </div>
  );
}

function setScrollGeometry(element: HTMLElement) {
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: 1_000 },
    clientHeight: { configurable: true, value: 200 },
    scrollTop: { configurable: true, value: 300, writable: true },
  });
  Object.defineProperty(element, "scrollTo", {
    configurable: true,
    value: vi.fn(({ top }: ScrollToOptions) => {
      element.scrollTop = Number(top);
    }),
  });
}

describe("useStickyScroll", () => {
  afterEach(cleanup);
  it("counts new items while away and resets when returning to latest", () => {
    const view = render(<StickyHarness />);
    const scroller = screen.getByTestId("scroller");
    setScrollGeometry(scroller);
    fireEvent.scroll(scroller);
    expect(screen.getByTestId("position")).toHaveTextContent("away");

    view.rerender(<StickyHarness count={3} />);
    expect(screen.getByTestId("unread")).toHaveTextContent("2");

    fireEvent.click(screen.getByRole("button", { name: "latest" }));
    expect(screen.getByTestId("position")).toHaveTextContent("bottom");
    expect(screen.getByTestId("unread")).toHaveTextContent("0");
  });

  it("snaps and clears unread state when the scope changes", () => {
    const view = render(<StickyHarness />);
    const scroller = screen.getByTestId("scroller");
    setScrollGeometry(scroller);
    fireEvent.scroll(scroller);
    view.rerender(<StickyHarness count={2} />);
    expect(screen.getByTestId("unread")).toHaveTextContent("1");

    view.rerender(<StickyHarness scope="channel:2" count={4} />);
    expect(screen.getByTestId("position")).toHaveTextContent("bottom");
    expect(screen.getByTestId("unread")).toHaveTextContent("0");
  });

  it("uses the same bottom threshold for distance helpers", () => {
    expect(distanceFromBottom({ scrollHeight: 1_000, scrollTop: 760, clientHeight: 200 })).toBe(40);
    expect(isNearBottom({ scrollHeight: 1_000, scrollTop: 760, clientHeight: 200 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1_000, scrollTop: 700, clientHeight: 200 })).toBe(false);
  });

  it("stays pinned when a streaming item grows without increasing item count", () => {
    const view = render(<StickyHarness revision={10} />);
    const scroller = screen.getByTestId("scroller");
    setScrollGeometry(scroller);
    scroller.scrollTop = 800;
    fireEvent.scroll(scroller);
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1_100 });

    view.rerender(<StickyHarness revision={20} />);
    expect(scroller.scrollTop).toBe(1_100);
  });
});

const mention: MentionApi = {
  active: false,
  options: [],
  selected: 0,
  menuId: "mention-menu",
  optionId: (index) => `mention-${index}`,
  activeDescendant: null,
  update: () => undefined,
  handleKey: () => false,
  choose: () => undefined,
  hover: () => undefined,
  hide: () => undefined,
  scheduleHide: () => undefined,
};

function TextareaHarness({ focusToken }: { focusToken: number }) {
  const textareaRef = createRef<HTMLTextAreaElement>();
  const pendingCaretRef = createRef<number | null>() as RefObject<number | null>;
  const isComposingRef = createRef<boolean>() as RefObject<boolean>;
  return (
    <I18nProvider>
      <ComposerTextarea
        textareaRef={textareaRef}
        pendingCaretRef={pendingCaretRef}
        isComposingRef={isComposingRef}
        value=""
        disabled={false}
        placeholder="Message"
        mode="private"
        menuId="mention-menu"
        focusToken={focusToken}
        mention={mention}
        onDraftChange={() => undefined}
        onSubmit={() => undefined}
        onAddFiles={() => undefined}
        notify={() => undefined}
      />
    </I18nProvider>
  );
}

describe("ComposerTextarea focus token", () => {
  afterEach(cleanup);
  it("does not focus an untouched mount but focuses after an explicit token bump", () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    const view = render(<TextareaHarness focusToken={0} />);
    expect(document.activeElement).not.toBe(screen.getByRole("textbox"));

    act(() => view.rerender(<TextareaHarness focusToken={1} />));
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
  });
});
