// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../i18n";
import { Markdown } from "./Markdown";

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn(), mermaidAPI: { getDiagramFromText: async () => ({ db: {} }) } }));
vi.mock("mermaid", () => ({ default: mermaid }));

const FENCE = "Here is the flow:\n\n```mermaid\nsequenceDiagram\n  Alice->>Bob: Hi\n```\n";

beforeEach(() => {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  mermaid.render.mockReset();
  mermaid.render.mockResolvedValue({ svg: '<svg data-testid="sequence"></svg>' });
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("Markdown mermaid fences", () => {
  it("draws a ```mermaid fence in a chat message, with its source a toggle away", async () => {
    render(<I18nProvider><Markdown content={FENCE} /></I18nProvider>);
    expect(await screen.findByTestId("sequence")).toBeInTheDocument();
    expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), "sequenceDiagram\n  Alice->>Bob: Hi");
    expect(screen.getByRole("figure", { name: "Mermaid diagram" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(await screen.findByText(/Alice->>Bob: Hi/)).toBeInTheDocument();
  });

  it("keeps the fence as code while it streams, then draws it", async () => {
    const { rerender } = render(<I18nProvider><Markdown content={FENCE} streaming /></I18nProvider>);
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
    expect(mermaid.render).not.toHaveBeenCalled();
    rerender(<I18nProvider><Markdown content={FENCE} /></I18nProvider>);
    expect(await screen.findByTestId("sequence")).toBeInTheDocument();
  });

  it("shows an invalid diagram as its code block", async () => {
    mermaid.render.mockRejectedValue(new Error("No diagram type detected"));
    render(<I18nProvider><Markdown content={"```mermaid\nnot a diagram\n```"} /></I18nProvider>);
    expect(await screen.findByText("This diagram has a syntax error; showing the source.")).toBeInTheDocument();
    expect(screen.getByText("not a diagram")).toBeInTheDocument();
  });

  it("shows a diagram with an image node as its code, without rendering it", async () => {
    render(<I18nProvider><Markdown content={'```mermaid\nflowchart LR\n  A@{ img: "https://tracker.example/p.png" } --> B\n```'} /></I18nProvider>);
    expect(await screen.findByText("This diagram loads outside images or styles, which aren't shown; showing the source.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it("leaves other fences as code blocks", () => {
    render(<I18nProvider><Markdown content={"```js\nconst a = 1\n```"} /></I18nProvider>);
    expect(screen.getByText("js")).toBeInTheDocument();
    expect(mermaid.render).not.toHaveBeenCalled();
  });
});
