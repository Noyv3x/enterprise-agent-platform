// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Icon } from "./Icon";

describe("Icon", () => {
  it("uses a stable default size", () => {
    const { container } = render(<Icon name="bot" />);
    const icon = container.querySelector("svg");

    expect(icon).toHaveAttribute("width", "18");
    expect(icon).toHaveAttribute("height", "18");
  });

  it("honors an explicit size", () => {
    const { container } = render(<Icon name="bot" size={24} />);
    const icon = container.querySelector("svg");

    expect(icon).toHaveAttribute("width", "24");
    expect(icon).toHaveAttribute("height", "24");
  });
});
