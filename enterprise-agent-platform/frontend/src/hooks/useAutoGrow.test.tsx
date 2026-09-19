// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoGrow } from "./useAutoGrow";

function Fixture({ value }: { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(ref, value);
  return <textarea ref={ref} value={value} readOnly placeholder="A long placeholder that wraps" />;
}

describe("useAutoGrow", () => {
  afterEach(cleanup);

  it("caps long input and restores the empty composer's CSS baseline after clearing", () => {
    const scrollHeight = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get")
      .mockReturnValue(340);

    const { rerender } = render(<Fixture value="Long input" />);
    expect(screenTextArea()).toHaveStyle({ height: "200px" });
    expect(screenTextArea()).toHaveClass("is-scrollable");

    rerender(<Fixture value="" />);
    expect(screenTextArea().style.height).toBe("");
    expect(screenTextArea()).not.toHaveClass("is-scrollable");
    scrollHeight.mockRestore();
  });

  it("grows and shrinks with non-empty content", () => {
    const scrollHeight = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get")
      .mockReturnValue(96);

    const { rerender } = render(<Fixture value="Two lines" />);

    expect(screenTextArea()).toHaveStyle({ height: "96px" });
    scrollHeight.mockReturnValue(48);
    rerender(<Fixture value="One line" />);
    expect(screenTextArea()).toHaveStyle({ height: "48px" });
    scrollHeight.mockRestore();
  });
});

function screenTextArea(): HTMLTextAreaElement {
  const textarea = document.querySelector("textarea");
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("textarea fixture missing");
  return textarea;
}
