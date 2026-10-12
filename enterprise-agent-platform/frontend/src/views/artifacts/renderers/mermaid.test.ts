// @vitest-environment jsdom

import mermaid from "mermaid";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { DiagramError, renderMermaid, withoutDirectives, withoutExternalReferences } from "./mermaid";

/* The real library parses each source; only `render` (which needs a layout engine jsdom lacks) is stubbed, so a
 * refused diagram is proven never to reach it. `Image` is replaced to prove nothing is fetched. */
const images = vi.fn();
let render: MockInstance<typeof mermaid.render>;

beforeEach(() => {
  images.mockReset();
  vi.stubGlobal("Image", class {
    src = "";
    constructor() { images(); }
    decode() { return Promise.resolve(); }
  });
  render = vi.spyOn(mermaid, "render").mockResolvedValue({ svg: '<svg id="d"><g><text>ok</text></g></svg>', diagramType: "flowchart" } as never);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function refusal(source: string) {
  const error = await renderMermaid(source, "light").then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(DiagramError);
  return (error as DiagramError).reason;
}

describe("renderMermaid never fetches", () => {
  it("refuses a flowchart image shape before rendering and never constructs an Image", async () => {
    expect(await refusal('flowchart LR\n  A@{ img: "https://tracker.example/p.png?d=secret", label: "x" } --> B')).toBe("external");
    expect(images).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it("refuses an image key spelled with a YAML escape, from the parsed diagram", async () => {
    expect(await refusal('flowchart LR\n  A@{ "\\x69mg": "https://tracker.example/p.png", label: "x" } --> B')).toBe("external");
    expect(images).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it("refuses a sequence actor icon", async () => {
    expect(await refusal('sequenceDiagram\n  participant A\n  properties A: {"\\u0069con": "https://tracker.example/i.png"}\n  A->>A: hi')).toBe("external");
    expect(render).not.toHaveBeenCalled();
  });

  it("refuses label HTML that loads, CSS url() and escaped style values", async () => {
    expect(await refusal('flowchart LR\n  A["<img src=https://tracker.example/p.png>"] --> B')).toBe("external");
    expect(await refusal("flowchart LR\n  A --> B\n  style A fill:url(https://tracker.example/p.png)")).toBe("external");
    expect(await refusal("flowchart LR\n  A --> B\n  classDef c fill:\\75 rl(https://tracker.example/p.png)")).toBe("external");
    expect(render).not.toHaveBeenCalled();
  });

  it("drops init directives and config frontmatter, so themeCSS cannot add an @import", async () => {
    const directive = '%%{init: {"themeCSS": "@import \'https://evil.example/x.css\';", "securityLevel": "loose"}}%%\nflowchart LR\n  A --> B';
    await renderMermaid(directive, "light");
    const frontmatter = "---\nconfig:\n  themeCSS: \"@import 'https://evil.example/x.css';\"\n---\nflowchart LR\n  A --> B";
    await renderMermaid(frontmatter, "dark");
    expect(render.mock.calls.map((call) => call[1].trimStart())).toEqual(["flowchart LR\n  A --> B", "flowchart LR\n  A --> B"]);
    expect(mermaid.mermaidAPI.getConfig().themeCSS).toBeUndefined();
  });

  it("keeps a directive from changing secure keys", async () => {
    await renderMermaid("flowchart LR\n  A --> B", "light");
    await mermaid.mermaidAPI.getDiagramFromText('%%{init: {"themeCSS": "@import url(x)", "securityLevel": "loose", "dompurifyConfig": {}}}%%\nflowchart LR\n  A --> B');
    const config = mermaid.mermaidAPI.getConfig();
    expect(config.securityLevel).toBe("strict");
    expect(config.themeCSS).toBeUndefined();
    expect(config.dompurifyConfig).toEqual(expect.objectContaining({ FORBID_TAGS: expect.arrayContaining(["img", "image"]) }));
  });

  it("renders a diagram whose labels mention URLs as plain text", async () => {
    const source = 'flowchart LR\n  A["Docs: https://example.com/guide.png"] --> B[example.com]';
    await expect(renderMermaid(source, "light")).resolves.toContain("<text>ok</text>");
    expect(render).toHaveBeenCalledWith(expect.any(String), source);
    expect(images).not.toHaveBeenCalled();
  });

  it("removes images, outside links, @import and external url() from the rendered SVG", async () => {
    render.mockResolvedValueOnce({
      svg: '<svg id="d"><style>@import url(https://evil.example/x.css); .n{fill:url(https://evil.example/p.png)} .m{marker-end:url(#arrow)}</style>'
        + '<image href="https://evil.example/i.png"></image><a href="https://example.com"><text>t</text></a>'
        + '<path marker-end="url(#arrow)" fill="url(https://evil.example/q.png)"></path><use href="#arrow"></use>'
        + '<foreignObject><div><img src="https://evil.example/r.png"></div></foreignObject></svg>',
      diagramType: "flowchart",
    } as never);
    const svg = await renderMermaid("flowchart LR\n  A --> B", "light");
    expect(svg).not.toMatch(/evil\.example|@import|<image|<img/);
    expect(svg).not.toContain('href="https://example.com"');
    expect(svg).toContain("url(#arrow)");
    expect(svg).toContain('<use href="#arrow">');
  });
});

describe("helpers", () => {
  it("strips every directive, unclosed ones too", () => {
    expect(withoutDirectives("%%{init: {}}%%\nflowchart LR\n%%{wrap}%%\nA-->B\n%%{init: {\"a\": 1}")).toBe("\nflowchart LR\n\nA-->B\n");
  });

  it("parses markup inertly", () => {
    expect(withoutExternalReferences('<svg><image href="https://x/y.png"></image></svg>')).toBe("<svg></svg>");
    expect(images).not.toHaveBeenCalled();
  });
});
