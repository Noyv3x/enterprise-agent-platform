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

  it("keeps an empty composer at its CSS single-line baseline without measuring the placeholder", () => {
    const scrollHeight = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get")
      .mockReturnValue(103);

    render(<Fixture value="" />);

    expect(screenTextArea()).not.toHaveStyle({ height: "103px" });
    expect(screenTextArea().style.height).toBe("");
    expect(scrollHeight).not.toHaveBeenCalled();
    scrollHeight.mockRestore();
  });

  it("still grows a non-empty composer to its bounded content height", () => {
    const scrollHeight = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get")
      .mockReturnValue(96);

    render(<Fixture value="Two lines" />);

    expect(screenTextArea()).toHaveStyle({ height: "96px" });
    expect(scrollHeight).toHaveBeenCalled();
    scrollHeight.mockRestore();
  });
});

function screenTextArea(): HTMLTextAreaElement {
  const textarea = document.querySelector("textarea");
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("textarea fixture missing");
  return textarea;
}
