// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import type { Message } from "../../types";
import { MessageBody } from "./MessageBody";
import { MessageBubble } from "./MessageBubble";

function renderLocalized(node: React.ReactNode) {
  return render(<I18nProvider>{node}</I18nProvider>);
}

describe("MessageBody", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(cleanup);

  it("renders GFM structure and a copyable fenced code block", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    renderLocalized(
      <MessageBody
        content={[
          "## Result",
          "",
          "- [x] completed",
          "",
          "| Name | Value |",
          "| --- | --- |",
          "| alpha | 1 |",
          "",
          "```ts",
          "const answer = 42;",
          "```",
        ].join("\n")}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Result" })).toBeTruthy();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.getByRole("table")).toHaveTextContent("alpha");
    expect(screen.getByText("ts")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledWith("const answer = 42;");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("drops raw HTML and prevents unsafe link protocols", async () => {
    renderLocalized(
      <MessageBody content={'<img src="x" onerror="alert(1)">\n\n[unsafe](javascript:alert(1))'} />,
    );

    expect(screen.queryByRole("img")).toBeNull();
    const link = (await screen.findByText("unsafe")).closest("a");
    expect(link).not.toBeNull();
    if (!link) throw new Error("Expected Markdown link");
    expect(link.getAttribute("href") || "").not.toMatch(/^javascript:/i);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("does not load remote images from Markdown", async () => {
    renderLocalized(<MessageBody content="![tracking pixel](https://example.test/pixel.png)" />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(await screen.findByRole("note")).toHaveTextContent("External image blocked: tracking pixel");
  });

  it("keeps incomplete streaming Markdown readable", () => {
    renderLocalized(<MessageBody content="**still generating" />);
    expect(screen.getByText("**still generating")).toBeTruthy();
  });

  it("copies the original full message from the message action", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const message: Message = {
      id: "message-1",
      scope_type: "channel",
      scope_id: "channel-1",
      author_type: "agent",
      user_id: null,
      username: "Main Agent",
      content: "**formatted** message",
      created_at: 1_700_000_000,
    };

    renderLocalized(<MessageBubble message={message} />);
    await user.click(screen.getByRole("button", { name: "Copy message" }));

    expect(writeText).toHaveBeenCalledWith("**formatted** message");
  });
});
