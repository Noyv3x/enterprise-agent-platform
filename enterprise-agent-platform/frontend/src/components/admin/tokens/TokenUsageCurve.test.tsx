// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../../i18n";
import { TokenUsageCurve } from "./TokenUsageCurve";

describe("TokenUsageCurve", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("keeps the fixed-ratio chart and its labels in one scrollable viewport", () => {
    render(
      <I18nProvider>
        <TokenUsageCurve rows={[{ date: "2026-07-22", total_tokens: 12_345 }]} />
      </I18nProvider>,
    );

    const viewport = screen.getByRole("region", { name: "7-day token usage chart" });
    expect(viewport).toHaveClass("token-curve__viewport");
    expect(viewport).toHaveAttribute("tabindex", "0");
    expect(within(viewport).getByRole("img", { name: "7-day token usage chart" }))
      .toHaveAttribute("preserveAspectRatio", "xMidYMid meet");
    expect(viewport.querySelector(".token-curve__plot")).toContainElement(
      viewport.querySelector(".token-curve__labels"),
    );
    expect(viewport.querySelectorAll(".token-curve__label")).toHaveLength(7);
  });
});
