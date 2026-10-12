// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../../i18n";
import type { ArtifactKind, ArtifactSource, ArtifactView } from "../types";
import { ArtifactDiff, ArtifactPreview, ArtifactSourceView } from ".";

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn(), mermaidAPI: { getDiagramFromText: async () => ({ db: {} }) } }));
vi.mock("mermaid", () => ({ default: mermaid }));

const wrap = (node: ReactNode) => render(<I18nProvider>{node}</I18nProvider>);

function artifact(kind: ArtifactKind, entry: string): ArtifactView {
  return { id: 7, scope: "private", path: `/workspace/${entry}`, kind, title: `My ${kind}`, entry, latest_version: 2, created_at: "", updated_at: "" };
}

/** A CodeBlock line, whose highlighting splits the text into spans. */
const codeLine = (text: string) => (_: string, element: Element | null) => element?.tagName === "CODE" && element.textContent === text;

const source = (content: string, truncated = false): ArtifactSource => ({ content, truncated, mime: "text/plain" });

function preview(kind: ArtifactKind, entry: string, content: string, viewUrl: string | null = null) {
  const loadSource = vi.fn(async () => source(content));
  wrap(<ArtifactPreview artifact={artifact(kind, entry)} version={2} entry={entry} viewUrl={viewUrl} loadSource={loadSource} />);
  return loadSource;
}

beforeEach(() => {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  mermaid.initialize.mockReset();
  mermaid.render.mockReset();
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("ArtifactPreview", () => {
  it("renders Markdown with the conversation renderer", async () => {
    const loadSource = preview("markdown", "report.md", "# Quarterly report\n\nRevenue **grew**.\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(await screen.findByRole("heading", { name: "Quarterly report" })).toBeInTheDocument();
    expect(screen.getByText("grew").tagName).toBe("STRONG");
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(loadSource).toHaveBeenCalledWith();
  });

  it("draws a Mermaid file with the strict security level", async () => {
    mermaid.render.mockResolvedValue({ svg: '<svg data-testid="diagram"><text>Start</text></svg>' });
    preview("mermaid", "flow.mmd", "flowchart LR\n  A[Start] --> B[End]");
    expect(await screen.findByTestId("diagram")).toBeInTheDocument();
    expect(screen.getByRole("figure", { name: "Mermaid diagram" })).toContainElement(screen.getByTestId("diagram"));
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: "strict", suppressErrorRendering: true, startOnLoad: false }));
    expect(mermaid.render).toHaveBeenCalledWith(expect.stringMatching(/^artifact-mermaid-\d+$/), "flowchart LR\n  A[Start] --> B[End]");
  });

  it("falls back to the source code when the diagram does not parse", async () => {
    mermaid.render.mockRejectedValue(new Error("Parse error on line 1"));
    preview("mermaid", "flow.mmd", "flowchart LR\n  A -->");
    expect(await screen.findByText("This diagram has a syntax error; showing the source.")).toBeInTheDocument();
    expect(screen.getByText("mermaid")).toBeInTheDocument();
    expect(screen.getByText("A -->")).toBeInTheDocument();
    expect(screen.queryByRole("figure")).not.toBeInTheDocument();
  });

  it("tables CSV with quoted commas and line breaks, the first 1,000 rows and a truncation note", async () => {
    const rows = Array.from({ length: 1204 }, (_, i) => `row ${i + 2},${i}`);
    preview("table", "people.csv", ['name,score', '"Lee, Ann\nsecond line","1,234"', ...rows].join("\r\n"));
    const table = await screen.findByRole("table");
    expect(screen.getByText("Showing the first 1,000 of 1,205 rows")).toBeInTheDocument();
    expect(within(table).getAllByRole("row")).toHaveLength(1001);
    expect(within(table).getByRole("columnheader", { name: "name" })).toBeInTheDocument();
    const first = within(table).getAllByRole("row")[1];
    expect(within(first).getByRole("cell", { name: /Lee, Ann\s+second line/ })).toBeInTheDocument();
    expect(within(table).getByText("row 1000")).toBeInTheDocument();
    expect(within(table).queryByText("row 1001")).not.toBeInTheDocument();
  });

  it("tables TSV on tabs without a note when every row shows", async () => {
    preview("table", "cities.tsv", "city\tpopulation\nParis, FR\t2100000\nLyon\t520000\n");
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByRole("cell", { name: "Paris, FR" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "2100000" })).toHaveClass("text-right");
    expect(screen.queryByText(/Showing the first/)).not.toBeInTheDocument();
  });

  it("shows code in a CodeBlock named after the entry", async () => {
    preview("code", "app.py", "def main():\n    return 42\n");
    expect(await screen.findByText("app.py")).toBeInTheDocument();
    expect(screen.getByText(codeLine("def main():"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
  });

  it("shows an SVG through the view URL as an image, never inline", async () => {
    const loadSource = preview("svg", "logo.svg", "", "/artifact-view/tok/logo.svg");
    const image = screen.getByRole("img", { name: "My svg" });
    expect(image.tagName).toBe("IMG");
    expect(image).toHaveAttribute("src", "/artifact-view/tok/logo.svg");
    expect(loadSource).not.toHaveBeenCalled();
  });

  it("waits for the view URL, then frames a PDF", () => {
    const view = artifact("pdf", "brief.pdf");
    const loadSource = vi.fn();
    const { rerender } = wrap(<ArtifactPreview artifact={view} version={1} entry="brief.pdf" viewUrl={null} loadSource={loadSource} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
    rerender(<I18nProvider><ArtifactPreview artifact={view} version={1} entry="brief.pdf" viewUrl="/artifact-view/tok/brief.pdf" loadSource={loadSource} /></I18nProvider>);
    expect(screen.getByTitle("My pdf")).toHaveAttribute("src", "/artifact-view/tok/brief.pdf");
  });

  it("offers a retry when the source fails to load", async () => {
    const loadSource = vi.fn().mockRejectedValueOnce(new Error("Artifact not found")).mockResolvedValueOnce(source("ok then"));
    wrap(<ArtifactPreview artifact={artifact("code", "a.txt")} version={1} entry="a.txt" viewUrl={null} loadSource={loadSource} />);
    expect(await screen.findByText("Artifact not found")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("ok then")).toBeInTheDocument();
  });
});

describe("ArtifactSourceView", () => {
  it("lists a site's files, entry first, and shows the picked file's source", async () => {
    const files = [
      { path: "css/site.css", size: 120, mime: "text/css" },
      { path: "img/logo.png", size: 2048, mime: "image/png" },
      { path: "index.html", size: 900, mime: "text/html" },
    ];
    const loadSource = vi.fn(async (path?: string) => source(path === "css/site.css" ? "body { margin: 0 }" : "<h1>Home</h1>"));
    wrap(<ArtifactSourceView artifact={artifact("site", "index.html")} version={3} entry="index.html" viewUrl={null} loadSource={loadSource} files={files} />);

    const list = screen.getByRole("navigation", { name: "Files" });
    const buttons = within(list).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["index.htmlentry", "css/site.css", "img/logo.png"]);
    expect(buttons[0]).toHaveAttribute("aria-current", "true");
    expect(await screen.findByText("<h1>Home</h1>")).toBeInTheDocument();

    await userEvent.click(buttons[1]);
    expect(await screen.findByText(codeLine("body { margin: 0 }"))).toBeInTheDocument();
    expect(loadSource).toHaveBeenLastCalledWith("css/site.css");

    await userEvent.click(buttons[2]);
    expect(await screen.findByText("This file isn't text")).toBeInTheDocument();
    expect(loadSource).toHaveBeenCalledTimes(2);
  });

  it("shows a single file without a list", async () => {
    const files = [{ path: "deck.html", size: 12, mime: "text/html; charset=utf-8" }];
    wrap(<ArtifactSourceView artifact={artifact("web", "deck.html")} version={1} entry="deck.html" viewUrl={null} loadSource={async () => source("<p>slide</p>")} files={files} />);
    expect(await screen.findByText("<p>slide</p>")).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("waits for the file list before reading, so an image never asks for its source", async () => {
    const loadSource = vi.fn(async () => source("never"));
    const view = artifact("image", "chart.png");
    const props = { artifact: view, version: 1, entry: "chart.png", viewUrl: null, loadSource };
    const { rerender } = wrap(<ArtifactSourceView {...props} files={null} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
    rerender(<I18nProvider><ArtifactSourceView {...props} files={[{ path: "chart.png", size: 2048, mime: "image/png" }]} /></I18nProvider>);
    expect(await screen.findByText("This file isn't text")).toBeInTheDocument();
    expect(loadSource).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reads the files Platform serves as text, by the same MIME rule", async () => {
    const files = [
      { path: "index.html", size: 1, mime: "text/html; charset=utf-8" },
      { path: "data.json", size: 1, mime: "application/json" },
      { path: "logo.svg", size: 1, mime: "image/svg+xml" },
      { path: "site.webmanifest", size: 1, mime: "application/manifest+json" },
      { path: "font.woff2", size: 1, mime: "font/woff2" },
      { path: "z.wasm", size: 1, mime: "application/wasm" },
    ];
    const loadSource = vi.fn(async (path?: string) => source(`content of ${path}`));
    wrap(<ArtifactSourceView artifact={artifact("site", "index.html")} version={1} entry="index.html" viewUrl={null} loadSource={loadSource} files={files} />);
    const list = screen.getByRole("navigation", { name: "Files" });
    for (const path of ["data.json", "logo.svg", "site.webmanifest"]) {
      await userEvent.click(within(list).getByRole("button", { name: path }));
      expect(await screen.findByText(codeLine(`content of ${path}`))).toBeInTheDocument();
    }
    for (const path of ["font.woff2", "z.wasm"]) {
      await userEvent.click(within(list).getByRole("button", { name: path }));
      expect(await screen.findByText("This file isn't text")).toBeInTheDocument();
    }
    expect(loadSource.mock.calls.map(([path]) => path)).toEqual(["index.html", "data.json", "logo.svg", "site.webmanifest"]);
  });
});

describe("ArtifactDiff", () => {
  it("diffs the entry against the previous version in the CodeBlock Diff variant", async () => {
    wrap(
      <ArtifactDiff
        artifact={artifact("markdown", "notes.md")}
        version={3}
        previousVersion={2}
        loadPreviousSource={async () => source("# Notes\nold line\nkept\n")}
        loadSource={async () => source("# Notes\nnew line\nkept\n")}
      />,
    );
    expect(await screen.findByText("notes.md · v2 → v3")).toBeInTheDocument();
    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(screen.getByText("-1")).toBeInTheDocument();
    expect(screen.getByText(codeLine("old line")).closest(".bg-red-tint")).not.toBeNull();
    expect(screen.getByText(codeLine("new line")).closest(".bg-green-tint")).not.toBeNull();
  });

  it("says when the versions have the same text", async () => {
    wrap(<ArtifactDiff artifact={artifact("code", "a.ts")} version={2} previousVersion={1} loadPreviousSource={async () => source("x\n")} loadSource={async () => source("x")} />);
    expect(await screen.findByText("v1 and v2 are the same")).toBeInTheDocument();
  });
});
